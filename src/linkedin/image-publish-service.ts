import { createHash, timingSafeEqual } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { ExactPublishClaimResult } from "../db/repositories.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import type { DraftMediaStorage } from "../media/storage.js";
import { hashApprovalCapabilityForSubject } from "../posts/preview-service.js";
import type { LinkedInPublishingClient } from "./publishing-client.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_URN_PATTERN = /^urn:li:image:[A-Za-z0-9_-]+$/;
const POST_URN_PATTERN = /^urn:li:(?:share|ugcPost):[0-9]+$/;

export type ImagePublishResult =
  | { state: "published"; postUrn: string }
  | { state: "media_upload_failed" }
  | { state: "media_upload_unknown" }
  | { state: "publish_failed" }
  | { state: "publish_unknown" };

export type ImagePublishServiceDependencies = Readonly<{
  subject: string;
  storage: DraftMediaStorage;
  client: LinkedInPublishingClient;
  publishEnabled: boolean;
  imagePublishEnabled: boolean;
  connectionValid: () => Promise<boolean>;
  clock?: () => Date;
}>;

function nowIso(clock: () => Date): string {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw new DomainError("DATA_INTEGRITY", "Publish clock is invalid", { entity: "publish_attempt" });
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Publish clock is invalid", { entity: "publish_attempt" });
  }
  return new Date(value.getTime()).toISOString();
}

function throwClaimOutcome(result: Exclude<ExactPublishClaimResult, { outcome: "recorded" }>): never {
  switch (result.outcome) {
    case "not_found":
      throw new DomainError("PREVIEW_INVALID", "Approval capability is invalid");
    case "already_consumed":
    case "race":
      throw new DomainError("PREVIEW_CONSUMED", "Approval capability has already been used");
    case "expired":
      throw new DomainError("PREVIEW_EXPIRED", "Approval capability has expired");
    case "stale":
      throw new DomainError("PREVIEW_STALE", "Post draft changed after preview");
    case "invalid_state":
      throw new DomainError("INVALID_TRANSITION", "Post draft is not available for publishing", {
        entity: "post_draft"
      });
    case "wrong_owner":
      throw new DomainError("NOT_FOUND", "Post draft was not found", { entity: "post_draft" });
    case "image_disabled":
      throw new DomainError("PUBLISH_DISABLED", "LinkedIn image publishing is disabled");
    case "integrity_mismatch":
      throw new DomainError("DATA_INTEGRITY", "Exact post preview is invalid", {
        entity: "post_preview"
      });
  }
}

function claimPersistenceError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const kind = postgresErrorKind(error);
  if (kind === "retryable" || kind === "unique") {
    throw new DomainError("CONFLICT", "Publish approval could not be claimed", {
      entity: "publish_attempt"
    });
  }
  throw new DomainError("DATA_INTEGRITY", "Publish approval could not be claimed", {
    entity: "publish_attempt"
  });
}

function exactSha256(bytes: Uint8Array, expected: string): boolean {
  const actual = createHash("sha256").update(bytes).digest();
  const expectedBytes = Buffer.from(expected, "hex");
  return expectedBytes.byteLength === actual.byteLength && timingSafeEqual(actual, expectedBytes);
}

function safeInitializeResult(value: unknown): Awaited<ReturnType<LinkedInPublishingClient["initializeImage"]>> {
  if (typeof value !== "object" || value === null) return { outcome: "unknown" };
  const result = value as Record<string, unknown>;
  if (result.outcome === "definite_failure") return { outcome: "definite_failure" };
  if (result.outcome === "unknown") return { outcome: "unknown" };
  if (
    result.outcome !== "ready"
    || typeof result.imageUrn !== "string"
    || !IMAGE_URN_PATTERN.test(result.imageUrn)
    || typeof result.uploadUrl !== "string"
  ) return { outcome: "unknown" };
  try {
    const upload = new URL(result.uploadUrl);
    const host = upload.hostname.toLowerCase().replace(/\.+$/u, "");
    if (
      upload.protocol !== "https:"
      || upload.username !== ""
      || upload.password !== ""
      || !(host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "licdn.com" || host.endsWith(".licdn.com"))
    ) return { outcome: "unknown" };
  } catch {
    return { outcome: "unknown" };
  }
  return { outcome: "ready", imageUrn: result.imageUrn, uploadUrl: result.uploadUrl };
}

function safeUploadResult(value: unknown): Awaited<ReturnType<LinkedInPublishingClient["uploadImage"]>> {
  if (typeof value !== "object" || value === null) return { outcome: "unknown" };
  const outcome = (value as { outcome?: unknown }).outcome;
  if (outcome === "uploaded" || outcome === "definite_failure" || outcome === "unknown") {
    return { outcome };
  }
  return { outcome: "unknown" };
}

function safePostResult(value: unknown): Awaited<ReturnType<LinkedInPublishingClient["createPost"]>> {
  if (typeof value !== "object" || value === null) return { outcome: "unknown" };
  const result = value as Record<string, unknown>;
  if (result.outcome === "definite_failure") return { outcome: "definite_failure" };
  if (result.outcome === "unknown") return { outcome: "unknown" };
  if (
    result.outcome === "published"
    && typeof result.postUrn === "string"
    && POST_URN_PATTERN.test(result.postUrn)
  ) return { outcome: "published", postUrn: result.postUrn };
  return { outcome: "unknown" };
}

export function createImagePublishService(
  database: CareerDatabase,
  dependencies: ImagePublishServiceDependencies
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const clock = dependencies.clock ?? (() => new Date());

  async function completeMediaAttempt(
    claim: Extract<ExactPublishClaimResult, { outcome: "recorded" }>,
    state: "media_upload_failed" | "media_upload_unknown"
  ): Promise<ImagePublishResult> {
    const responseCategory = state === "media_upload_failed"
      ? "media_definite_rejection" as const
      : "media_ambiguous" as const;
    try {
      const completion = {
        id: claim.attempt.id,
        postDraftId: claim.post.id,
        version: claim.post.version,
        nextPostState: state,
        responseCategory,
        completedAt: nowIso(clock),
        sanitizedError: state === "media_upload_failed"
          ? "LinkedIn media upload failed"
          : "LinkedIn media upload result is unknown"
      } as const;
      const completed = await database.publishAttempts.complete({
        ...completion,
        expectedPhase: "uploading_media",
        expectedPostState: "uploading_media"
      });
      if (completed) return { state };
      const completedAfterPhaseUncertainty = await database.publishAttempts.complete({
        ...completion,
        expectedPhase: "creating_post",
        expectedPostState: "publishing"
      });
      return completedAfterPhaseUncertainty ? { state } : { state: "media_upload_unknown" };
    } catch {
      return { state: "media_upload_unknown" };
    }
  }

  async function completeMedia(
    claim: Extract<ExactPublishClaimResult, { outcome: "recorded" }>,
    attemptMediaId: string,
    state: "media_upload_failed" | "media_upload_unknown"
  ): Promise<ImagePublishResult> {
    const mediaState = state === "media_upload_failed" ? "definite_failure" : "unknown";
    try {
      const updatedMedia = await database.publishAttemptMedia.updateState({
        id: attemptMediaId,
        state: mediaState
      });
      if (updatedMedia === undefined) return completeMediaAttempt(claim, "media_upload_unknown");
    } catch {
      return completeMediaAttempt(claim, "media_upload_unknown");
    }
    return completeMediaAttempt(claim, state);
  }

  return {
    async publish(approvalCapability: string): Promise<ImagePublishResult> {
      if (!dependencies.publishEnabled) {
        throw new DomainError("PUBLISH_DISABLED", "LinkedIn publishing is disabled");
      }
      let connected: boolean;
      try {
        connected = await dependencies.connectionValid();
      } catch {
        connected = false;
      }
      if (!connected) {
        throw new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization is required");
      }

      let tokenHash: string;
      try {
        tokenHash = hashApprovalCapabilityForSubject(approvalCapability, subject);
      } catch (error) {
        throw error;
      }
      let claim: Extract<ExactPublishClaimResult, { outcome: "recorded" }>;
      try {
        const result = await database.publishAttempts.claimExact({
          tokenHash,
          consumedAt: nowIso(clock),
          subject,
          imagePublishEnabled: dependencies.imagePublishEnabled
        });
        if (result.outcome !== "recorded") throwClaimOutcome(result);
        claim = result;
      } catch (error) {
        return claimPersistenceError(error);
      }

      const uploaded: Array<{ imageUrn: string; altText: string }> = [];
      const attemptMediaByPosition = new Map(
        claim.attemptMedia.map((item) => [item.position, item] as const)
      );
      const verified: Array<{
        media: (typeof claim.media)[number];
        attemptMedia: (typeof claim.attemptMedia)[number];
        bytes: Uint8Array;
      }> = [];
      for (let position = 0; position < claim.media.length; position += 1) {
        const media = claim.media[position]!;
        const attemptMedia = attemptMediaByPosition.get(position);
        if (attemptMedia === undefined || attemptMedia.position !== position) {
          return completeMediaAttempt(claim, "media_upload_unknown");
        }

        let bytes: Uint8Array;
        try {
          bytes = await dependencies.storage.download(media.objectPath);
        } catch {
          return completeMedia(claim, attemptMedia.id, "media_upload_failed");
        }
        if (!(bytes instanceof Uint8Array) || !exactSha256(bytes, media.sha256)) {
          return completeMedia(claim, attemptMedia.id, "media_upload_failed");
        }
        verified.push({ media, attemptMedia, bytes });
      }

      for (const { media, attemptMedia, bytes } of verified) {
        let initialized: Awaited<ReturnType<LinkedInPublishingClient["initializeImage"]>>;
        try {
          initialized = safeInitializeResult(await dependencies.client.initializeImage());
        } catch {
          initialized = { outcome: "unknown" };
        }
        if (initialized.outcome !== "ready") {
          return completeMedia(
            claim,
            attemptMedia.id,
            initialized.outcome === "definite_failure"
              ? "media_upload_failed"
              : "media_upload_unknown"
          );
        }
        try {
          const persisted = await database.publishAttemptMedia.updateState({
            id: attemptMedia.id,
            expectedState: "pending",
            state: "initialized",
            linkedinImageUrn: initialized.imageUrn
          });
          if (persisted === undefined) {
            return completeMedia(claim, attemptMedia.id, "media_upload_unknown");
          }
        } catch {
          return completeMedia(claim, attemptMedia.id, "media_upload_unknown");
        }

        let upload: Awaited<ReturnType<LinkedInPublishingClient["uploadImage"]>>;
        try {
          upload = safeUploadResult(await dependencies.client.uploadImage({
            uploadUrl: initialized.uploadUrl,
            bytes,
            mimeType: media.mimeType as "image/jpeg" | "image/png" | "image/gif"
          }));
        } catch {
          upload = { outcome: "unknown" };
        }
        if (upload.outcome !== "uploaded") {
          return completeMedia(
            claim,
            attemptMedia.id,
            upload.outcome === "definite_failure"
              ? "media_upload_failed"
              : "media_upload_unknown"
          );
        }
        try {
          const persisted = await database.publishAttemptMedia.updateState({
            id: attemptMedia.id,
            expectedState: "initialized",
            state: "uploaded",
            linkedinImageUrn: initialized.imageUrn
          });
          if (persisted === undefined) {
            return completeMedia(claim, attemptMedia.id, "media_upload_unknown");
          }
        } catch {
          return completeMedia(claim, attemptMedia.id, "media_upload_unknown");
        }
        uploaded.push({ imageUrn: initialized.imageUrn, altText: media.altText });
      }

      if (claim.media.length > 0) {
        try {
          const transitioned = await database.publishAttempts.transitionToCreatingPost({
            id: claim.attempt.id,
            postDraftId: claim.post.id,
            version: claim.post.version
          });
          if (!transitioned) return completeMediaAttempt(claim, "media_upload_unknown");
        } catch {
          return completeMediaAttempt(claim, "media_upload_unknown");
        }
      }

      let postResult: Awaited<ReturnType<LinkedInPublishingClient["createPost"]>>;
      try {
        postResult = safePostResult(await dependencies.client.createPost({
          text: claim.post.text,
          visibility: claim.post.visibility as "PUBLIC" | "CONNECTIONS",
          media: uploaded
        }));
      } catch {
        postResult = { outcome: "unknown" };
      }
      const completion = postResult.outcome === "published"
        ? {
            result: { state: "published" as const, postUrn: postResult.postUrn },
            nextPostState: "published" as const,
            responseCategory: "published" as const,
            postUrn: postResult.postUrn
          }
        : postResult.outcome === "definite_failure"
          ? {
              result: { state: "publish_failed" as const },
              nextPostState: "publish_failed" as const,
              responseCategory: "definite_rejection" as const,
              sanitizedError: "LinkedIn rejected this post"
            }
          : {
              result: { state: "publish_unknown" as const },
              nextPostState: "publish_unknown" as const,
              responseCategory: "ambiguous" as const,
              sanitizedError: "LinkedIn publish result is unknown"
            };
      try {
        const completed = await database.publishAttempts.complete({
          id: claim.attempt.id,
          postDraftId: claim.post.id,
          version: claim.post.version,
          expectedPhase: "creating_post",
          expectedPostState: "publishing",
          nextPostState: completion.nextPostState,
          responseCategory: completion.responseCategory,
          completedAt: nowIso(clock),
          ...(completion.postUrn === undefined ? {} : { postUrn: completion.postUrn }),
          ...(completion.sanitizedError === undefined
            ? {}
            : { sanitizedError: completion.sanitizedError })
        });
        return completed ? completion.result : { state: "publish_unknown" };
      } catch {
        return { state: "publish_unknown" };
      }
    }
  };
}

export type ImagePublishService = ReturnType<typeof createImagePublishService>;
