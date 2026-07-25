import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TOKEN_BYTES = 32;
const CAPABILITY_LIFETIME_MS = 15 * 60 * 1_000;

export type PrivateFounderExportCapability = Readonly<{
  capability: string;
  expiresAt: string;
}>;

export type FounderExportDownload = Readonly<{
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  checksumSha256: string;
}>;

function unavailable(): DomainError {
  return new DomainError("NOT_FOUND", "Founder research export is unavailable");
}

function integrityFailure(): DomainError {
  return new DomainError(
    "DATA_INTEGRITY",
    "Founder research export integrity could not be verified"
  );
}

function trustedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Founder export clock is invalid");
  }
  return value;
}

function canonicalToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === TOKEN_BYTES && bytes.toString("base64url") === value
    ? value
    : undefined;
}

function matchingHexSha256(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Issues a raw token only for a caller that will place it in private metadata. */
export async function issuePrivateFounderExportCapability(
  database: CareerDatabase,
  input: Readonly<{ exportId: string; ownerSubject: string; now: Date }>
): Promise<PrivateFounderExportCapability> {
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + CAPABILITY_LIFETIME_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const capability = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHashSha256 = createHash("sha256").update(capability, "utf8").digest("hex");
    try {
      await database.founderExportCapabilities.create({
        exportId: input.exportId,
        ownerSubject: input.ownerSubject,
        tokenHashSha256,
        createdAt,
        expiresAt
      });
      return Object.freeze({ capability, expiresAt });
    } catch (error) {
      if (attempt === 2 || postgresErrorKind(error) !== "unique") throw error;
    }
  }
  throw integrityFailure();
}

export function createFounderExportDownloadService(
  database: CareerDatabase,
  dependencies: Readonly<{ subject: string; now?: () => Date }>
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const now = dependencies.now ?? (() => new Date());
  return Object.freeze({
    async download(exportId: string, rawCapability: unknown): Promise<FounderExportDownload> {
      if (!UUID_PATTERN.test(exportId)) throw unavailable();
      const capability = canonicalToken(rawCapability);
      if (capability === undefined) throw unavailable();
      const requestNow = trustedNow(now);
      const tokenHashSha256 = createHash("sha256").update(capability, "utf8").digest("hex");
      const usable = await database.founderExportCapabilities.getUsable({
        exportId: exportId.toLowerCase(),
        ownerSubject: subject,
        tokenHashSha256,
        now: requestNow.toISOString()
      });
      if (
        usable === undefined
        || !matchingHexSha256(usable.capability.tokenHashSha256, tokenHashSha256)
      ) {
        throw unavailable();
      }
      const bytes = Buffer.from(usable.export.workbookBytes);
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      if (!matchingHexSha256(usable.export.checksumSha256, checksumSha256)) {
        throw integrityFailure();
      }
      return Object.freeze({
        bytes,
        fileName: usable.export.fileName,
        mimeType: usable.export.mimeType,
        checksumSha256: usable.export.checksumSha256
      });
    }
  });
}
