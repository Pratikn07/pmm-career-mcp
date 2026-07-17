import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import { DomainError } from "../domain/errors.js";

const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const ENVELOPE_FIELDS = Object.freeze([
  "version",
  "algorithm",
  "iv",
  "authTag",
  "ciphertext"
]);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
const AUTHENTICATED_CONTEXT = Buffer.from(
  "pmm-career-mcp.encrypted-json.v1\0AES-256-GCM",
  "utf8"
);

export type EncryptedEnvelope = {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ENVELOPE_ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
};

function safeError(code: "INVALID_KEY" | "INVALID_JSON_VALUE" | "INVALID_ENVELOPE", message: string) {
  return new DomainError(code, message);
}

function parseKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw safeError("INVALID_KEY", "Encryption key must be exactly 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSupportedJson(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
    }
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
      }
      return;
    }
    if (typeof current !== "object") {
      throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
    }
    if (ancestors.has(current)) {
      throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const enumerableKeys = Object.keys(current);
        if (
          enumerableKeys.length !== current.length
          || enumerableKeys.some((key, index) => key !== String(index))
        ) {
          throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
          }
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      if (!isPlainRecord(current)) {
        throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
          throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0);
}

function encodeJson(value: unknown): Buffer {
  assertSupportedJson(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw safeError("INVALID_JSON_VALUE", "Value is not supported JSON");
  }
  return bytes;
}

function decodeCanonicalBase64Url(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value
    || (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  return decoded;
}

function parseEnvelope(value: unknown): {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isPlainRecord(value)) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== ENVELOPE_FIELDS.length
    || keys.some((key) => typeof key !== "string" || !ENVELOPE_FIELDS.includes(key))
  ) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  for (const field of ENVELOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
    }
  }
  const envelope = value as Partial<EncryptedEnvelope>;
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ENVELOPE_ALGORITHM) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  const iv = decodeCanonicalBase64Url(envelope.iv, NONCE_BYTES);
  const authTag = decodeCanonicalBase64Url(envelope.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
  if (ciphertext.length < 1 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
    throw safeError("INVALID_ENVELOPE", "Encrypted envelope is invalid");
  }
  return { iv, authTag, ciphertext };
}

export function encryptJson(value: unknown, key: string): EncryptedEnvelope {
  const encryptionKey = parseKey(key);
  const plaintext = encodeJson(value);
  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, {
    authTagLength: AUTH_TAG_BYTES
  });
  cipher.setAAD(AUTHENTICATED_CONTEXT);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptJson(envelope: EncryptedEnvelope, key: string): unknown {
  const encryptionKey = parseKey(key);
  const parsed = parseEnvelope(envelope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, parsed.iv, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(AUTHENTICATED_CONTEXT);
    decipher.setAuthTag(parsed.authTag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final()
    ]).toString("utf8");
    const decoded: unknown = JSON.parse(plaintext);
    assertSupportedJson(decoded);
    return decoded;
  } catch {
    throw new DomainError("DECRYPTION_FAILED", "Encrypted value could not be decrypted");
  }
}
