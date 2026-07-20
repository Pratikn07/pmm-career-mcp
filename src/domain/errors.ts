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
  | "MEDIA_STORAGE_ERROR"
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

export type PostgresErrorKind =
  | "foreign_key"
  | "unique"
  | "retryable"
  | "invalid_text_representation";

function safeSqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function postgresErrorKind(error: unknown): PostgresErrorKind | undefined {
  switch (safeSqlState(error)) {
    case "23503":
      return "foreign_key";
    case "23505":
      return "unique";
    case "40001":
    case "40P01":
      return "retryable";
    case "22P02":
      return "invalid_text_representation";
    default:
      return undefined;
  }
}
