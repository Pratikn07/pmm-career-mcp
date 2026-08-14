import { randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { PostDraft, PostDraftMediaWithMetadata } from "../db/repositories.js";
import type { PostVisibility } from "../drafts/service.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import type { DraftMediaStorage } from "../media/storage.js";
import { checksumLinkedInPost } from "./post-checksum.js";
import {
  APPROVAL_CAPABILITY_HASH_CONTEXT,
  hashApprovalCapabilityForSubject
} from "./preview-service.js";

export { APPROVAL_CAPABILITY_HASH_CONTEXT };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_BYTES = 32;
const PREVIEW_LIFETIME_SECONDS = 900;
const PREVIEW_LIFETIME_MS = PREVIEW_LIFETIME_SECONDS * 1_000;
const MAX_MEDIA = 4;
const MAX_POST_CHARACTERS = 3_000;
const MAX_ALT_TEXT_CHARACTERS = 120;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 36_152_320;
const MAX_GIF_FRAMES = 250;
const REVIEWABLE_STATES = Object.freeze(["draft", "ready_for_review", "previewed"]);

export type ExactPreviewMedia = Readonly<{
  position: number;
  mediaId: string;
  altText: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  originalFilename: string | null;
  createdAt: string;
}>;

export type ExactPreview = Readonly<{
  postId: string;
  versionId: string;
  text: string;
  version: number;
  checksum: string;
  visibility: PostVisibility;
  characterCount: number;
  media: readonly ExactPreviewMedia[];
  expiresAt: string;
}>;

export type SignedPreviewMediaUrl = Readonly<{
  position: number;
  url: string;
}>;

export type ExactPreviewResult = Readonly<{
  preview: ExactPreview;
  approvalCapability: string;
  signedMediaUrls: readonly SignedPreviewMediaUrl[];
}>;

export type ReviewServiceDependencies = Readonly<{
  subject: string;
  storage: DraftMediaStorage;
  clock?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}>;

function safeIntegrityError(): DomainError {
  return new DomainError("DATA_INTEGRITY", "Exact post preview could not be created", {
    entity: "post_preview"
  });
}

function validPostId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "Exact preview input is invalid", {
      field: "preview.postId",
      reason: "must_be_uuid"
    });
  }
  return value;
}

function validVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DomainError("VALIDATION_ERROR", "Exact preview input is invalid", {
      field: "preview.version",
      reason: "must_be_positive_integer"
    });
  }
  return value as number;
}

function exactNow(clock: () => Date): Date {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw safeIntegrityError();
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw safeIntegrityError();
  }
  const copied = new Date(value.getTime());
  if (!Number.isFinite(new Date(copied.getTime() + PREVIEW_LIFETIME_MS).getTime())) {
    throw safeIntegrityError();
  }
  return copied;
}

function approvalCapability(randomBytes: (size: number) => Uint8Array): string {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(TOKEN_BYTES);
  } catch {
    throw safeIntegrityError();
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
    throw safeIntegrityError();
  }
  const capability = Buffer.from(bytes).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    throw safeIntegrityError();
  }
  return capability;
}

function isVisibility(value: string): value is PostVisibility {
  return value === "PUBLIC" || value === "CONNECTIONS";
}

function isMimeType(value: string): value is ExactPreviewMedia["mimeType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif";
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function exactMedia(
  rows: readonly PostDraftMediaWithMetadata[],
  subject: string,
  versionId: string,
  version: number
): { preview: ExactPreviewMedia[]; objectPaths: string[] } {
  if (rows.length > MAX_MEDIA) throw safeIntegrityError();
  const preview: ExactPreviewMedia[] = [];
  const objectPaths: string[] = [];
  const mediaIds = new Set<string>();
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position]!;
    const altTextLength = [...row.altText].length;
    if (
      row.position !== position
      || row.postDraftId !== versionId
      || row.version !== version
      || row.ownerSubject.toLowerCase() !== subject
      || !row.objectPath.startsWith(`${subject}/`)
      || !UUID_PATTERN.test(row.mediaId)
      || mediaIds.has(row.mediaId.toLowerCase())
      || !SHA256_PATTERN.test(row.sha256)
      || !isMimeType(row.mimeType)
      || !Number.isSafeInteger(row.byteSize)
      || row.byteSize < 1
      || row.byteSize > MAX_IMAGE_BYTES
      || !Number.isSafeInteger(row.width)
      || !Number.isSafeInteger(row.height)
      || row.width < 1
      || row.height < 1
      || row.width * row.height >= MAX_IMAGE_PIXELS
      || !Number.isSafeInteger(row.frameCount)
      || row.frameCount < 1
      || row.frameCount > MAX_GIF_FRAMES
      || altTextLength < 1
      || altTextLength > MAX_ALT_TEXT_CHARACTERS
      || /[\r\n\u2028\u2029]/u.test(row.altText)
      || (row.originalFilename !== null && [...row.originalFilename].length > 255)
      || !isCanonicalTimestamp(row.createdAt)
    ) {
      if (row.ownerSubject.toLowerCase() !== subject) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", {
          entity: "post_draft"
        });
      }
      throw safeIntegrityError();
    }
    mediaIds.add(row.mediaId.toLowerCase());
    objectPaths.push(row.objectPath);
    preview.push({
      position: row.position,
      mediaId: row.mediaId,
      altText: row.altText,
      sha256: row.sha256,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      frameCount: row.frameCount,
      originalFilename: row.originalFilename,
      createdAt: row.createdAt
    });
  }
  return { preview, objectPaths };
}

function exactPost(
  post: PostDraft,
  media: readonly ExactPreviewMedia[]
): { visibility: PostVisibility; checksum: string } {
  if (
    !UUID_PATTERN.test(post.id)
    || !UUID_PATTERN.test(post.draftId)
    || !Number.isSafeInteger(post.version)
    || post.version < 1
    || typeof post.text !== "string"
    || [...post.text].length > MAX_POST_CHARACTERS
    || !isVisibility(post.visibility)
    || !SHA256_PATTERN.test(post.checksum)
  ) {
    throw safeIntegrityError();
  }
  let checksum: string;
  try {
    checksum = checksumLinkedInPost({
      draftId: post.draftId,
      version: post.version,
      text: post.text,
      visibility: post.visibility,
      media: media.map(({ position, sha256, mimeType, altText }) => ({
        position,
        sha256,
        mimeType,
        altText
      }))
    });
  } catch {
    throw safeIntegrityError();
  }
  if (!timingSafeEqual(Buffer.from(checksum, "hex"), Buffer.from(post.checksum, "hex"))) {
    throw safeIntegrityError();
  }
  return { visibility: post.visibility, checksum };
}

function persistenceError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  switch (postgresErrorKind(error)) {
    case "foreign_key":
      throw new DomainError("PREVIEW_STALE", "Post draft changed before preview was created", {
        entity: "post_draft"
      });
    case "unique":
    case "retryable":
      throw new DomainError("CONFLICT", "Exact post preview could not be created", {
        entity: "post_preview"
      });
    default:
      throw safeIntegrityError();
  }
}

export function createReviewService(
  database: CareerDatabase,
  dependencies: ReviewServiceDependencies
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const clock = dependencies.clock ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;

  return {
    async createExact(postIdInput: string, versionInput: number): Promise<ExactPreviewResult> {
      const postId = validPostId(postIdInput);
      const version = validVersion(versionInput);
      const now = exactNow(clock);
      const capability = approvalCapability(randomBytes);
      const tokenHash = hashApprovalCapabilityForSubject(capability, subject);
      const expiresAt = new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString();

      const versions = await database.postDrafts.listVersions(postId);
      const latest = versions.at(-1);
      if (latest === undefined) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", {
          entity: "post_draft"
        });
      }
      const selected = versions.find((candidate) => candidate.version === version);
      if (selected === undefined) {
        throw new DomainError("NOT_FOUND", "Post draft version was not found", {
          entity: "post_draft"
        });
      }
      if (latest.id !== selected.id) {
        throw new DomainError("PREVIEW_STALE", "Only the latest post version can be previewed", {
          entity: "post_draft"
        });
      }
      if (!REVIEWABLE_STATES.includes(selected.state)) {
        throw new DomainError("INVALID_TRANSITION", "Post draft is not available for preview", {
          entity: "post_draft"
        });
      }

      const rows = await database.postDraftMedia.listForVersion(selected.id, selected.version);
      const media = exactMedia(rows, subject, selected.id, selected.version);
      const canonical = exactPost(selected, media.preview);
      let signedMediaUrls: SignedPreviewMediaUrl[];
      try {
        signedMediaUrls = await Promise.all(media.objectPaths.map(async (path, position) => ({
          position,
          url: await dependencies.storage.createSignedUrl(path, PREVIEW_LIFETIME_SECONDS)
        })));
      } catch {
        throw new DomainError("MEDIA_STORAGE_ERROR", "Draft media storage operation failed");
      }

      try {
        const result = await database.previews.createForLatest({
          draftId: postId,
          version,
          tokenHash,
          expiresAt,
          allowedStates: REVIEWABLE_STATES,
          expectedVersionId: selected.id,
          expectedChecksum: canonical.checksum,
          snapshotChecksum: canonical.checksum,
          expectedSnapshot: {
            subject,
            post: {
              id: selected.id,
              draftId: selected.draftId,
              text: selected.text,
              visibility: selected.visibility,
              version: selected.version,
              checksum: selected.checksum
            },
            media: rows.map((row) => ({ ...row }))
          },
          replaceUnconsumedAt: now.toISOString(),
          nextState: "previewed"
        });
        switch (result.outcome) {
          case "not_found":
            throw new DomainError("NOT_FOUND", "Post draft version was not found", {
              entity: "post_draft"
            });
          case "not_latest":
            throw new DomainError("PREVIEW_STALE", "Only the latest post version can be previewed", {
              entity: "post_draft"
            });
          case "invalid_state":
            throw new DomainError("INVALID_TRANSITION", "Post draft is not available for preview", {
              entity: "post_draft"
            });
          case "integrity_mismatch":
            throw safeIntegrityError();
          case "created": {
            const preview: ExactPreview = {
              postId: result.post.draftId,
              versionId: result.post.id,
              text: result.post.text,
              version: result.post.version,
              checksum: canonical.checksum,
              visibility: canonical.visibility,
              characterCount: [...result.post.text].length,
              media: media.preview,
              expiresAt: result.preview.expiresAt
            };
            return {
              preview,
              approvalCapability: capability,
              signedMediaUrls
            };
          }
        }
      } catch (error) {
        return persistenceError(error);
      }
    }
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
