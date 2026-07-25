import { createHash } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import {
  PostDraftVersionConflictError,
  type OutreachDraft,
  type PostDraft,
  type PostDraftMediaWithMetadata
} from "../db/repositories.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import {
  checksumLinkedInPost,
  type LinkedInPostChecksumMedia
} from "../posts/post-checksum.js";

export const POST_CHECKSUM_CONTRACT = "pmm-career-mcp.post-draft.sha256.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_VISIBILITY_VALUES = ["PUBLIC", "CONNECTIONS"] as const;

export type PostVisibility = typeof POST_VISIBILITY_VALUES[number];

const POST_VISIBILITY_SET: ReadonlySet<string> = new Set(POST_VISIBILITY_VALUES);

export const POST_VISIBILITIES: readonly PostVisibility[] = Object.freeze([
  ...POST_VISIBILITY_VALUES
]);

const MAX_ID_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 100;
const MAX_OUTREACH_TEXT_LENGTH = 2_000;
const MAX_EVIDENCE_IDS = 25;
const MAX_POST_TEXT_LENGTH = 3_000;

export type CreateOutreachInput = {
  targetId: string;
  purpose: string;
  text: string;
  evidenceIds: readonly string[];
};

export type LegacyOutreachDraft = Omit<OutreachDraft, "requestId" | "requestPayloadHash">;

export type CreatePostInput = {
  text: string;
  visibility: PostVisibility;
};

/** `id` is the stable logical draft ID; `versionId` identifies one immutable row. */
export type PostDraftVersion = Omit<
  PostDraft,
  "id" | "draftId" | "ownerSubject" | "visibility"
> & {
  id: string;
  versionId: string;
  visibility: PostVisibility;
  media: readonly PostDraftMediaVersion[];
};

export type PostDraftMediaVersion = Readonly<{
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

function validationError(field: string, reason: string, maximum?: number): DomainError {
  return new DomainError("VALIDATION_ERROR", "Draft input is invalid", {
    field,
    reason,
    ...(maximum === undefined ? {} : { maximum })
  });
}

function normalizedText(field: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") {
    throw validationError(field, "must_be_text");
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    throw validationError(field, "must_not_be_empty");
  }
  if ([...normalized].length > maximum) {
    throw validationError(field, "too_long", maximum);
  }
  return normalized;
}

function normalizedId(field: string, value: unknown): string {
  return normalizedText(field, value, MAX_ID_LENGTH);
}

function normalizedPurpose(value: unknown): string {
  return normalizedText("outreach.purpose", value, MAX_PURPOSE_LENGTH).replace(/\s+/g, " ");
}

function isPostVisibility(value: unknown): value is PostVisibility {
  return typeof value === "string" && POST_VISIBILITY_SET.has(value);
}

function isDraftMediaMimeType(value: string): value is PostDraftMediaVersion["mimeType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif";
}

function publicPostMedia(row: PostDraftMediaWithMetadata): PostDraftMediaVersion {
  if (!isDraftMediaMimeType(row.mimeType)) {
    throw new DomainError("DATA_INTEGRITY", "Stored draft media type is invalid", {
      entity: "post_media"
    });
  }
  const {
    postDraftId: _postDraftId,
    version: _version,
    ownerSubject: _ownerSubject,
    objectPath: _objectPath,
    ...media
  } = row;
  return { ...media, mimeType: row.mimeType };
}

function publicPostDraft(
  row: PostDraft,
  media: readonly PostDraftMediaWithMetadata[] = []
): PostDraftVersion {
  if (!isPostVisibility(row.visibility)) {
    throw new DomainError("DATA_INTEGRITY", "Stored post visibility is invalid", {
      entity: "post_draft"
    });
  }
  const {
    id: versionId,
    draftId: id,
    ownerSubject: _ownerSubject,
    visibility,
    ...version
  } = row;
  return { ...version, id, versionId, visibility, media: media.map(publicPostMedia) };
}

function legacyOutreachDraft(row: OutreachDraft): LegacyOutreachDraft {
  const { requestId: _requestId, requestPayloadHash: _requestPayloadHash, ...draft } = row;
  return draft;
}

function mapDraftPersistenceError(error: unknown, entity: "outreach_draft" | "post_draft"): never {
  const constraint = postgresErrorKind(error);
  if (constraint === "foreign_key") {
    throw new DomainError("NOT_FOUND", "Referenced draft record was not found", { entity });
  }
  if (constraint === "unique") {
    throw new DomainError("CONFLICT", "Draft version conflicts with existing data", { entity });
  }
  if (constraint === "retryable") {
    throw new DomainError("CONFLICT", "Draft write could not be completed", { entity });
  }
  throw new DomainError("DATA_INTEGRITY", "Draft could not be saved", { entity });
}

/**
 * SHA-256 over four NUL-delimited UTF-8 fields: contract name, decimal
 * version, exact-text UTF-8 byte length, and the exact normalized saved text.
 */
export function computePostChecksum(exactText: string, version: number): string {
  if (typeof exactText !== "string") {
    throw validationError("post.text", "must_be_text");
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw validationError("post.version", "must_be_positive_integer");
  }
  const canonical = [
    POST_CHECKSUM_CONTRACT,
    String(version),
    String(Buffer.byteLength(exactText, "utf8")),
    exactText
  ].join("\u0000");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type DraftService = ReturnType<typeof createDraftService>;

export function createDraftService(
  database: CareerDatabase,
  dependencies: { subject: string }
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  return {
    async createOutreach(input: CreateOutreachInput): Promise<LegacyOutreachDraft> {
      if (typeof input !== "object" || input === null) {
        throw validationError("outreach", "must_be_object");
      }
      const targetId = normalizedId("outreach.targetId", input.targetId);
      const purpose = normalizedPurpose(input.purpose);
      const text = normalizedText("outreach.text", input.text, MAX_OUTREACH_TEXT_LENGTH);
      if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
        throw validationError("outreach.evidenceIds", "must_not_be_empty");
      }
      if (input.evidenceIds.length > MAX_EVIDENCE_IDS) {
        throw validationError("outreach.evidenceIds", "too_many", MAX_EVIDENCE_IDS);
      }
      const evidenceIds = input.evidenceIds.map((evidenceId) => (
        normalizedId("outreach.evidenceIds", evidenceId)
      ));
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        throw new DomainError("CONFLICT", "Outreach evidence IDs must be unique", {
          entity: "evidence"
        });
      }

      const target = await database.targets.get(targetId);
      if (target === undefined) {
        throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
      }
      for (const evidenceId of evidenceIds) {
        const item = await database.evidence.get(evidenceId);
        if (item === undefined) {
          throw new DomainError("NOT_FOUND", "Evidence was not found", { entity: "evidence" });
        }
        if (item.personId !== target.personId) {
          throw new DomainError(
            "EVIDENCE_MISMATCH",
            "Evidence does not belong to the target person",
            { entity: "evidence" }
          );
        }
      }

      try {
        return legacyOutreachDraft(await database.outreachDrafts.createVersion({
          targetId,
          purpose,
          text,
          evidenceIds: [...evidenceIds]
        }));
      } catch (error) {
        return mapDraftPersistenceError(error, "outreach_draft");
      }
    },

    async createPost(input: CreatePostInput): Promise<PostDraftVersion> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw validationError("post", "must_be_object");
      }
      const unsupportedFields = Object.keys(input).filter((field) => (
        field !== "text" && field !== "visibility"
      ));
      if (unsupportedFields.length > 0) {
        throw validationError("post", "unsupported_field");
      }
      const text = normalizedText("post.text", input.text, MAX_POST_TEXT_LENGTH);
      if (!isPostVisibility(input.visibility)) {
        throw validationError("post.visibility", "unsupported_visibility");
      }

      try {
        const created = await database.postDrafts.createVersionWithMedia({
          ownerSubject: subject,
          text,
          visibility: input.visibility,
          checksum: (version, draftId) => checksumLinkedInPost({
            draftId,
            version,
            text,
            visibility: input.visibility,
            media: []
          }),
          state: "draft",
          media: []
        });
        return publicPostDraft(created.post, created.media);
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        return mapDraftPersistenceError(error, "post_draft");
      }
    },

    async revisePost(draftIdInput: string, textInput: string): Promise<PostDraftVersion> {
      const draftId = normalizedId("post.id", draftIdInput);
      const text = normalizedText("post.text", textInput, MAX_POST_TEXT_LENGTH);
      const ownerSubject = await database.postDraftOwners.getOwner(draftId);
      if (ownerSubject?.toLowerCase() !== subject) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", {
          entity: "post_draft"
        });
      }
      const latest = (await database.postDrafts.listVersions(draftId)).at(-1);
      if (latest === undefined) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", {
          entity: "post_draft"
        });
      }
      if (!isPostVisibility(latest.visibility)) {
        throw new DomainError("DATA_INTEGRITY", "Stored post visibility is invalid", {
          entity: "post_draft"
        });
      }
      const visibility = latest.visibility;
      const latestMedia = await database.postDraftMedia.listForVersion(latest.id, latest.version);

      try {
        const revised = await database.postDrafts.createVersionWithMedia({
          draftId,
          expectedVersion: latest.version,
          ownerSubject: subject,
          text,
          visibility,
          checksum: (version, actualDraftId, media) => checksumLinkedInPost({
            draftId: actualDraftId,
            version,
            text,
            visibility,
            media: media as readonly LinkedInPostChecksumMedia[]
          }),
          state: "draft",
          media: latestMedia.map(({ mediaId, altText }) => ({ mediaId, altText }))
        });
        return publicPostDraft(revised.post, revised.media);
      } catch (error) {
        if (error instanceof PostDraftVersionConflictError) {
          throw new DomainError("CONFLICT", "Post draft version is stale", {
            entity: "post_draft"
          });
        }
        if (error instanceof DomainError) {
          throw error;
        }
        return mapDraftPersistenceError(error, "post_draft");
      }
    },

    async getPostVersion(
      draftIdInput: string,
      version: number
    ): Promise<PostDraftVersion | undefined> {
      const draftId = normalizedId("post.id", draftIdInput);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw validationError("post.version", "must_be_positive_integer");
      }
      const ownerSubject = await database.postDraftOwners.getOwner(draftId);
      if (ownerSubject?.toLowerCase() !== subject) return undefined;
      const row = await database.postDrafts.getVersion(draftId, version);
      if (row === undefined) return undefined;
      const media = await database.postDraftMedia.listForVersion(row.id, row.version);
      return publicPostDraft(row, media);
    },

    async getPostHistory(draftIdInput: string): Promise<PostDraftVersion[]> {
      const draftId = normalizedId("post.id", draftIdInput);
      const ownerSubject = await database.postDraftOwners.getOwner(draftId);
      if (ownerSubject?.toLowerCase() !== subject) return [];
      const rows = await database.postDrafts.listVersions(draftId);
      return await Promise.all(rows.map(async (row) => publicPostDraft(
        row,
        await database.postDraftMedia.listForVersion(row.id, row.version)
      )));
    }
  };
}
