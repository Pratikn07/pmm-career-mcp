import { createHash } from "node:crypto";

export const POST_CHECKSUM_CONTRACT = "pmm-career-mcp.linkedin-post.sha256.v2";

export type LinkedInPostChecksumMedia = Readonly<{
  position: number;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  altText: string;
}>;

export type LinkedInPostChecksumInput = Readonly<{
  draftId: string;
  version: number;
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  media: readonly LinkedInPostChecksumMedia[];
}>;

const UINT32_MAX = 0xffff_ffff;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function uint32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new TypeError("Checksum integer field is outside the uint32 range");
  }
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function lengthPrefixed(value: string, maximumStringBytes: number): Buffer {
  if (typeof value !== "string") {
    throw new TypeError("Checksum string field must be text");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > UINT32_MAX || bytes.byteLength > maximumStringBytes) {
    throw new RangeError("Checksum string field is too large");
  }
  return Buffer.concat([uint32(bytes.byteLength), bytes]);
}

export function checksumLinkedInPost(
  input: LinkedInPostChecksumInput,
  contract = POST_CHECKSUM_CONTRACT,
  maximumStringBytes = UINT32_MAX
): string {
  if (!Number.isInteger(maximumStringBytes) || maximumStringBytes < 0 || maximumStringBytes > UINT32_MAX) {
    throw new TypeError("Checksum string limit is outside the uint32 range");
  }
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > UINT32_MAX) {
    throw new TypeError("Checksum version must be a positive uint32");
  }
  if (!Array.isArray(input.media) || input.media.length > UINT32_MAX) {
    throw new TypeError("Checksum media must be an array within the uint32 range");
  }

  const chunks: Buffer[] = [
    lengthPrefixed(contract, maximumStringBytes),
    lengthPrefixed(input.draftId, maximumStringBytes),
    uint32(input.version),
    lengthPrefixed(input.text, maximumStringBytes),
    lengthPrefixed(input.visibility, maximumStringBytes),
    uint32(input.media.length)
  ];

  for (const item of input.media) {
    if (!LOWERCASE_SHA256.test(item.sha256)) {
      throw new TypeError("Checksum media SHA-256 must be 64 lowercase hexadecimal characters");
    }
    chunks.push(
      uint32(item.position),
      lengthPrefixed(item.sha256, maximumStringBytes),
      lengthPrefixed(item.mimeType, maximumStringBytes),
      lengthPrefixed(item.altText, maximumStringBytes)
    );
  }

  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}
