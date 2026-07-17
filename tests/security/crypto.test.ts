import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope
} from "../../src/security/crypto.js";
import {
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  redactSecrets
} from "../../src/security/redact.js";

const KEY = "00".repeat(32);
const OTHER_KEY = "11".repeat(32);

function expectSafeDomainError(action: () => unknown, code: string): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(OTHER_KEY);
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

describe("encrypted JSON envelopes", () => {
  it.each([
    null,
    true,
    false,
    0,
    -12.5,
    "",
    "Café 🙂",
    [null, true, 42, "value", { nested: [false] }],
    { access_token: "private", expires_in: 3600, active: true, optional: null }
  ])("round trips supported JSON value %# with an authenticated versioned envelope", (value) => {
    const envelope = encryptJson(value, KEY);

    expect(envelope).toEqual({
      version: 1,
      algorithm: "AES-256-GCM",
      iv: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      authTag: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]+$/)
    });
    expect(decodeBase64Url(envelope.iv)).toHaveLength(12);
    expect(decodeBase64Url(envelope.authTag)).toHaveLength(16);
    expect(decryptJson(envelope, KEY)).toEqual(value);
  });

  it("uses a fresh cryptographically generated 96-bit nonce for each encryption", () => {
    const nonces = new Set(
      Array.from({ length: 64 }, () => encryptJson({ same: "plaintext" }, KEY).iv)
    );

    expect(nonces.size).toBe(64);
  });

  it("rejects keys that are not exactly 64 hexadecimal characters", () => {
    for (const invalidKey of [
      "",
      "00".repeat(31),
      "00".repeat(33),
      `${"00".repeat(31)}0g`,
      ` ${KEY}`,
      `${KEY}\n`
    ]) {
      expectSafeDomainError(() => encryptJson({ secret: "value" }, invalidKey), "INVALID_KEY");
      expectSafeDomainError(
        () => decryptJson(encryptJson({ safe: true }, KEY), invalidKey),
        "INVALID_KEY"
      );
    }
  });

  it("maps wrong keys and authenticated tampering to one safe failure", () => {
    const envelope = encryptJson({ access_token: "plaintext-that-must-never-leak" }, KEY);
    const tamperedCiphertext = Buffer.from(decodeBase64Url(envelope.ciphertext));
    tamperedCiphertext[0] = tamperedCiphertext[0]! ^ 1;

    for (const candidate of [
      { envelope, key: OTHER_KEY },
      {
        envelope: { ...envelope, ciphertext: tamperedCiphertext.toString("base64url") },
        key: KEY
      },
      {
        envelope: {
          ...envelope,
          authTag: Buffer.alloc(16, 42).toString("base64url")
        },
        key: KEY
      }
    ]) {
      const error = expectSafeDomainError(
        () => decryptJson(candidate.envelope, candidate.key),
        "DECRYPTION_FAILED"
      );
      expect(error.message).toBe("Encrypted value could not be decrypted");
      expect(JSON.stringify(error)).not.toContain("plaintext-that-must-never-leak");
      expect(JSON.stringify(error)).not.toContain(envelope.ciphertext);
    }
  });

  it("strictly validates version, algorithm, canonical base64url, field set, and sizes", () => {
    const valid = encryptJson({ safe: true }, KEY);
    const invalidEnvelopes: unknown[] = [
      null,
      [],
      { ...valid, version: 2 },
      { ...valid, algorithm: "AES-128-GCM" },
      { ...valid, iv: Buffer.alloc(11).toString("base64url") },
      { ...valid, iv: Buffer.alloc(13).toString("base64url") },
      { ...valid, authTag: Buffer.alloc(15).toString("base64url") },
      { ...valid, authTag: Buffer.alloc(17).toString("base64url") },
      { ...valid, ciphertext: `${valid.ciphertext}=` },
      { ...valid, ciphertext: "***" },
      { ...valid, extra: "field" },
      { version: 1, algorithm: "AES-256-GCM", iv: valid.iv, authTag: valid.authTag }
    ];

    for (const envelope of invalidEnvelopes) {
      expectSafeDomainError(
        () => decryptJson(envelope as EncryptedEnvelope, KEY),
        "INVALID_ENVELOPE"
      );
    }
  });

  it("rejects unsupported, cyclic, sparse, accessor, and prototype-polluting JSON shapes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(2);
    sparse[1] = "present";
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "secret" });
    const polluted = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}') as unknown;

    for (const unsupported of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("secret"),
      () => "secret",
      new Date(),
      cyclic,
      sparse,
      accessor,
      polluted,
      { constructor: { prototype: { polluted: true } } }
    ]) {
      expectSafeDomainError(() => encryptJson(unsupported, KEY), "INVALID_JSON_VALUE");
    }

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("structured secret redaction", () => {
  it("deeply redacts case and separator variants plus encrypted envelopes", () => {
    const envelope = encryptJson({ hidden: "plaintext" }, KEY);
    const input = {
      Authorization: "Bearer access-secret",
      ACCESS_TOKEN: "access-secret",
      "refresh-token": "refresh-secret",
      clientSecret: "client-secret",
      "client.secret": "client-secret-2",
      State: "oauth-state",
      preview_token: "preview-secret",
      safe: "retained",
      nested: [
        { authorization_header: "also-secret", keep: 42 },
        { credential: envelope }
      ]
    };
    const before = structuredClone(input);

    const redacted = redactSecrets(input);

    expect(redacted).toEqual({
      Authorization: REDACTED_VALUE,
      ACCESS_TOKEN: REDACTED_VALUE,
      "refresh-token": REDACTED_VALUE,
      clientSecret: REDACTED_VALUE,
      "client.secret": REDACTED_VALUE,
      State: REDACTED_VALUE,
      preview_token: REDACTED_VALUE,
      safe: "retained",
      nested: [
        { authorization_header: REDACTED_VALUE, keep: 42 },
        { credential: REDACTED_VALUE }
      ]
    });
    expect(input).toEqual(before);
    expect(JSON.stringify(redacted)).not.toContain("access-secret");
    expect(JSON.stringify(redacted)).not.toContain(envelope.ciphertext);
  });

  it("handles cycles without mutating the input or recursing forever", () => {
    const input: { safe: string; accessToken: string; self?: unknown } = {
      safe: "retained",
      accessToken: "secret"
    };
    input.self = input;

    const redacted = redactSecrets(input) as typeof input;

    expect(redacted).not.toBe(input);
    expect(redacted.safe).toBe("retained");
    expect(redacted.accessToken).toBe(REDACTED_VALUE);
    expect(redacted.self).toBe(redacted);
    expect(input.accessToken).toBe("secret");
    expect(input.self).toBe(input);
  });

  it("bounds adversarial depth and collection size with safe sentinels", () => {
    let deep: Record<string, unknown> = { accessToken: "deep-secret" };
    for (let index = 0; index < 100; index += 1) {
      deep = { next: deep };
    }
    const oversized = Array.from({ length: 10_100 }, (_, index) => ({ index }));

    const redactedDepth = redactSecrets(deep);
    const redactedSize = redactSecrets(oversized) as unknown[];

    expect(JSON.stringify(redactedDepth)).toContain(TRUNCATED_VALUE);
    expect(redactedSize).toContain(TRUNCATED_VALUE);
  });
});
