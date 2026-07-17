import { createHash } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { OutreachDraft, PostDraft } from "../db/repositories.js";
import { DomainError, sqliteConstraintKind } from "../domain/errors.js";

export const POST_CHECKSUM_CONTRACT = "pmm-career-mcp.post-draft.sha256.v1";
export const POST_VISIBILITIES = ["PUBLIC", "CONNECTIONS"] as const;

export type PostVisibility = typeof POST_VISIBILITIES[number];

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

export type CreatePostInput = {
  text: string;
  visibility: PostVisibility;
};

/** `id` is the stable logical draft ID; `versionId` identifies one immutable row. */
export type PostDraftVersion = Omit<PostDraft, "id" | "draftId" | "visibility"> & {
  id: string;
  versionId: string;
  visibility: PostVisibility;
};

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
  return typeof value === "string" && (POST_VISIBILITIES as readonly string[]).includes(value);
}

function publicPostDraft(row: PostDraft): PostDraftVersion {
  if (!isPostVisibility(row.visibility)) {
    throw new DomainError("DATA_INTEGRITY", "Stored post visibility is invalid", {
      entity: "post_draft"
    });
  }
  const { id: versionId, draftId: id, visibility, ...version } = row;
  return { ...version, id, versionId, visibility };
}

function mapDraftPersistenceError(error: unknown, entity: "outreach_draft" | "post_draft"): never {
  const constraint = sqliteConstraintKind(error);
  if (constraint === "foreign_key") {
    throw new DomainError("NOT_FOUND", "Referenced draft record was not found", { entity });
  }
  if (constraint === "unique") {
    throw new DomainError("CONFLICT", "Draft version conflicts with existing data", { entity });
  }
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "SQLITE_BUSY"
  ) {
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

export function createDraftService(database: CareerDatabase) {
  return {
    createOutreach(input: CreateOutreachInput): OutreachDraft {
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

      const target = database.targets.get(targetId);
      if (target === undefined) {
        throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
      }
      for (const evidenceId of evidenceIds) {
        const item = database.evidence.get(evidenceId);
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
        return database.outreachDrafts.createVersion({
          targetId,
          purpose,
          text,
          evidenceIds: [...evidenceIds]
        });
      } catch (error) {
        return mapDraftPersistenceError(error, "outreach_draft");
      }
    },

    createPost(input: CreatePostInput): PostDraftVersion {
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
        return publicPostDraft(database.postDrafts.createVersion({
          text,
          visibility: input.visibility,
          checksum: (version) => computePostChecksum(text, version),
          state: "draft"
        }));
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        return mapDraftPersistenceError(error, "post_draft");
      }
    },

    revisePost(draftIdInput: string, textInput: string): PostDraftVersion {
      const draftId = normalizedId("post.id", draftIdInput);
      const text = normalizedText("post.text", textInput, MAX_POST_TEXT_LENGTH);
      const latest = database.postDrafts.listVersions(draftId).at(-1);
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

      try {
        return publicPostDraft(database.postDrafts.createVersion({
          draftId,
          text,
          visibility: latest.visibility,
          checksum: (version) => computePostChecksum(text, version),
          state: "draft"
        }));
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        return mapDraftPersistenceError(error, "post_draft");
      }
    },

    getPostVersion(draftIdInput: string, version: number): PostDraftVersion | undefined {
      const draftId = normalizedId("post.id", draftIdInput);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw validationError("post.version", "must_be_positive_integer");
      }
      const row = database.postDrafts.getVersion(draftId, version);
      return row === undefined ? undefined : publicPostDraft(row);
    },

    getPostHistory(draftIdInput: string): PostDraftVersion[] {
      const draftId = normalizedId("post.id", draftIdInput);
      return database.postDrafts.listVersions(draftId).map(publicPostDraft);
    }
  };
}
