export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_KEY"
  | "INVALID_JSON_VALUE"
  | "INVALID_ENVELOPE"
  | "DECRYPTION_FAILED"
  | "OAUTH_STATE_INVALID"
  | "OAUTH_PROVIDER_ERROR"
  | "PUBLISH_DISABLED"
  | "PREVIEW_INVALID"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_CONSUMED"
  | "PREVIEW_MISMATCH"
  | "PREVIEW_STALE"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "CONFLICT"
  | "EVIDENCE_MISMATCH"
  | "DATA_INTEGRITY";

export type DomainErrorDetails = Readonly<Record<string, string | number | boolean>>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function sqliteConstraintKind(error: unknown): "foreign_key" | "unique" | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return undefined;
  }
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    return "foreign_key";
  }
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return "unique";
  }
  return undefined;
}
