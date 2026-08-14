import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { PreviewConsumptionResult } from "../db/repositories.js";
import type { PostVisibility } from "../drafts/service.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";

export const PREVIEW_TOKEN_HASH_CONTEXT = "pmm-career-mcp.preview-token.sha256.v1";
export const APPROVAL_CAPABILITY_HASH_CONTEXT =
  "pmm-career-mcp.linkedin-preview-capability.sha256.v1";
export const APPROVAL_CAPABILITY_OWNER_HASH_CONTEXT =
  "pmm-career-mcp.linkedin-preview-capability-owner.sha256.v1";
const TOKEN_BYTES = 32;
const TOKEN_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_ID_LENGTH = 256;
const POST_VISIBILITIES: ReadonlySet<string> = new Set(["PUBLIC", "CONNECTIONS"]);
const PUBLISHABLE_STATES = Object.freeze(["draft", "publish_failed"]);

export type PreviewResult = {
  postId: string;
  versionId: string;
  text: string;
  version: number;
  checksum: string;
  visibility: PostVisibility;
  characterCount: number;
  previewToken: string;
  expiresAt: string;
};

export type PreviewExpected = {
  postId: string;
  versionId: string;
  version: number;
  checksum: string;
  visibility: PostVisibility;
};

export type PreviewServiceDependencies = {
  clock?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
};

function validationError(field: string, reason: string): DomainError {
  return new DomainError("VALIDATION_ERROR", "Preview input is invalid", { field, reason });
}

function canonicalNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Preview clock returned an invalid value", {
      entity: "preview"
    });
  }
  return new Date(value.getTime());
}

function validId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_LENGTH) {
    throw validationError(field, "must_be_bounded_text");
  }
  return value;
}

function parseToken(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DomainError("PREVIEW_INVALID", "Preview token is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== TOKEN_BYTES || decoded.toString("base64url") !== value) {
    throw new DomainError("PREVIEW_INVALID", "Preview token is invalid");
  }
  return decoded;
}

export function hashPreviewToken(token: string): string {
  const bytes = parseToken(token);
  return createHash("sha256")
    .update(PREVIEW_TOKEN_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(bytes)
    .digest("hex");
}

function parseApprovalCapability(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DomainError("PREVIEW_INVALID", "Approval capability is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== TOKEN_BYTES || decoded.toString("base64url") !== value) {
    throw new DomainError("PREVIEW_INVALID", "Approval capability is invalid");
  }
  return decoded;
}

export function hashApprovalCapability(capability: string): string {
  const bytes = parseApprovalCapability(capability);
  return createHash("sha256")
    .update(APPROVAL_CAPABILITY_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(bytes)
    .digest("hex");
}

export function hashApprovalCapabilityForSubject(capability: string, subject: string): string {
  const bytes = parseApprovalCapability(capability);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  return createHash("sha256")
    .update(APPROVAL_CAPABILITY_OWNER_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(subject.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(bytes)
    .digest("hex");
}

function parseExpected(value: PreviewExpected): PreviewExpected {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("preview.expected", "must_be_object");
  }
  const fields = Object.keys(value);
  const expectedFields = ["postId", "versionId", "version", "checksum", "visibility"];
  if (
    fields.length !== expectedFields.length
    || fields.some((field) => !expectedFields.includes(field))
  ) {
    throw validationError("preview.expected", "unsupported_field");
  }
  const postId = validId("preview.postId", value.postId);
  const versionId = validId("preview.versionId", value.versionId);
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw validationError("preview.version", "must_be_positive_integer");
  }
  if (typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum)) {
    throw validationError("preview.checksum", "must_be_sha256");
  }
  if (!POST_VISIBILITIES.has(value.visibility)) {
    throw validationError("preview.visibility", "unsupported_visibility");
  }
  return {
    postId,
    versionId,
    version: value.version,
    checksum: value.checksum,
    visibility: value.visibility
  };
}

function mapPreviewPersistenceError(error: unknown): never {
  if (error instanceof DomainError) {
    throw error;
  }
  const constraint = postgresErrorKind(error);
  if (constraint === "unique") {
    throw new DomainError("CONFLICT", "Preview token could not be created", {
      entity: "preview"
    });
  }
  if (constraint === "foreign_key") {
    throw new DomainError("PREVIEW_STALE", "Post draft changed before preview was created", {
      entity: "post_draft"
    });
  }
  if (constraint === "retryable") {
    throw new DomainError("CONFLICT", "Preview operation could not be completed", {
      entity: "preview",
      retryable: true
    });
  }
  throw new DomainError("DATA_INTEGRITY", "Preview operation could not be completed", {
    entity: "preview"
  });
}

function throwConsumptionOutcome(result: PreviewConsumptionResult): never {
  switch (result.outcome) {
    case "not_found":
      throw new DomainError("PREVIEW_INVALID", "Preview token is invalid");
    case "already_consumed":
    case "race":
      throw new DomainError("PREVIEW_CONSUMED", "Preview token has already been used");
    case "expired":
      throw new DomainError("PREVIEW_EXPIRED", "Preview token has expired");
    case "mismatch":
      throw new DomainError("PREVIEW_MISMATCH", "Preview does not match the requested post");
    case "stale":
      throw new DomainError("PREVIEW_STALE", "Post draft changed after preview");
    case "invalid_state":
      throw new DomainError("INVALID_TRANSITION", "Post draft is not available for publishing", {
        entity: "post_draft"
      });
    case "consumed":
      throw new DomainError("DATA_INTEGRITY", "Preview consumption result is invalid", {
        entity: "preview"
      });
  }
}

export function createPreviewService(
  database: CareerDatabase,
  dependencies: PreviewServiceDependencies = {}
) {
  const clock = dependencies.clock ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;

  return {
    async create(postIdInput: string, versionInput: number): Promise<PreviewResult> {
      const postId = validId("preview.postId", postIdInput);
      if (!Number.isSafeInteger(versionInput) || versionInput < 1) {
        throw validationError("preview.version", "must_be_positive_integer");
      }
      const now = canonicalNow(clock);
      let entropy: Uint8Array;
      try {
        entropy = randomBytes(TOKEN_BYTES);
      } catch {
        throw new DomainError("DATA_INTEGRITY", "Preview token could not be generated", {
          entity: "preview"
        });
      }
      if (!(entropy instanceof Uint8Array) || entropy.byteLength !== TOKEN_BYTES) {
        throw new DomainError("DATA_INTEGRITY", "Preview token could not be generated", {
          entity: "preview"
        });
      }
      const previewToken = Buffer.from(entropy).toString("base64url");
      const tokenHash = hashPreviewToken(previewToken);
      const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS).toISOString();

      try {
        const result = await database.previews.createForLatest({
          draftId: postId,
          version: versionInput,
          tokenHash,
          expiresAt,
          allowedStates: PUBLISHABLE_STATES
        });
        if (result.outcome === "not_found") {
          throw new DomainError("NOT_FOUND", "Post draft version was not found", {
            entity: "post_draft"
          });
        }
        if (result.outcome === "not_latest") {
          throw new DomainError("PREVIEW_STALE", "Only the latest post version can be previewed", {
            entity: "post_draft"
          });
        }
        if (result.outcome === "invalid_state") {
          throw new DomainError("INVALID_TRANSITION", "Post draft is not available for preview", {
            entity: "post_draft"
          });
        }
        if (result.outcome !== "created") {
          throw new DomainError("DATA_INTEGRITY", "Preview creation result is invalid", {
            entity: "preview"
          });
        }
        if (!POST_VISIBILITIES.has(result.post.visibility)) {
          throw new DomainError("DATA_INTEGRITY", "Stored post visibility is invalid", {
            entity: "post_draft"
          });
        }
        return {
          postId: result.post.draftId,
          versionId: result.post.id,
          text: result.post.text,
          version: result.post.version,
          checksum: result.post.checksum,
          visibility: result.post.visibility as PostVisibility,
          characterCount: [...result.post.text].length,
          previewToken,
          expiresAt: result.preview.expiresAt
        };
      } catch (error) {
        return mapPreviewPersistenceError(error);
      }
    },

    async consume(tokenInput: string, expectedInput: PreviewExpected): Promise<void> {
      const tokenHash = hashPreviewToken(tokenInput);
      const expected = parseExpected(expectedInput);
      const consumedAt = canonicalNow(clock).toISOString();
      try {
        const result = await database.previews.consumeExact({
          tokenHash,
          consumedAt,
          expected,
          allowedStates: PUBLISHABLE_STATES
        });
        if (result.outcome !== "consumed") {
          throwConsumptionOutcome(result);
        }
      } catch (error) {
        return mapPreviewPersistenceError(error);
      }
    }
  };
}

export type PreviewService = ReturnType<typeof createPreviewService>;
