import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestAuthContext } from "../../src/auth/request-context.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createSupabaseDraftMediaStorage,
  type DraftMediaStorage
} from "../../src/media/storage.js";

const mocks = vi.hoisted(() => {
  const upload = vi.fn();
  const download = vi.fn();
  const createSignedUrl = vi.fn();
  const remove = vi.fn();
  const fileApi = { upload, download, createSignedUrl, remove };
  const from = vi.fn();
  const clientFactory = vi.fn();
  return { upload, download, createSignedUrl, remove, fileApi, from, clientFactory };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.clientFactory }));

type StorageConfig = Readonly<{
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  linkedinMediaBucket: "linkedin-draft-media";
}>;

const migrationPath = resolve(
  import.meta.dirname,
  "../../supabase/migrations/20260719000000_linkedin_media_storage_rls.sql"
);
const policySql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

const url = "https://project-ref.supabase.co";
const publishableKey = "sb_publishable_storage-test-key_123456789";
const accessToken = "request-user-jwt-that-must-not-leak";
const subject = "123e4567-e89b-42d3-a456-426614174000";
const objectPath = `${subject}/a1/media-id/image.png`;
const config: StorageConfig = {
  supabaseUrl: url,
  supabasePublishableKey: publishableKey,
  linkedinMediaBucket: "linkedin-draft-media"
};
const auth: RequestAuthContext = { subject, accessToken };

async function createStorage(
  storageConfig: StorageConfig = config,
  requestAuth: RequestAuthContext = auth
): Promise<DraftMediaStorage> {
  return createSupabaseDraftMediaStorage(storageConfig, requestAuth);
}

async function expectSafeStorageError(
  action: () => Promise<unknown>,
  forbiddenValue?: string
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe("MEDIA_STORAGE_ERROR");
    expect(domainError.message).toBe("Draft media storage operation failed");
    expect(domainError.details).toEqual({});
    expect(Object.hasOwn(domainError, "cause")).toBe(false);
    if (forbiddenValue !== undefined) {
      expect(`${domainError.stack ?? ""}\n${JSON.stringify(domainError)}`).not.toContain(forbiddenValue);
    }
    return domainError;
  }
  throw new Error("Expected a DomainError");
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

beforeEach(() => {
  mocks.upload.mockReset();
  mocks.download.mockReset();
  mocks.createSignedUrl.mockReset();
  mocks.remove.mockReset();
  mocks.from.mockReset();
  mocks.clientFactory.mockReset();

  mocks.upload.mockResolvedValue({
    data: { id: "object-id", path: objectPath, fullPath: `linkedin-draft-media/${objectPath}` },
    error: null
  });
  mocks.download.mockResolvedValue({ data: new Blob([Uint8Array.of(1, 2, 3)]), error: null });
  mocks.createSignedUrl.mockResolvedValue({
    data: { signedUrl: `${url}/storage/v1/object/sign/linkedin-draft-media/${objectPath}?token=signed` },
    error: null
  });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.from.mockReturnValue(mocks.fileApi);
  mocks.clientFactory.mockReturnValue({ storage: { from: mocks.from } });
});

describe("Supabase draft media Storage adapter", () => {
  it("uses only the publishable key and current request bearer token for every bucket operation", async () => {
    const storage = await createStorage();
    const bytes = Uint8Array.of(1, 2, 3);

    await expect(storage.upload(objectPath, bytes, "image/png")).resolves.toBeUndefined();
    await expect(storage.download(objectPath)).resolves.toEqual(bytes);
    await expect(storage.createSignedUrl(objectPath, 900)).resolves.toBe(
      `${url}/storage/v1/object/sign/linkedin-draft-media/${objectPath}?token=signed`
    );
    await expect(storage.remove([objectPath])).resolves.toBeUndefined();

    expect(mocks.clientFactory).toHaveBeenCalledTimes(1);
    expect(mocks.clientFactory).toHaveBeenCalledWith(url, publishableKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    expect(mocks.from).toHaveBeenCalledTimes(4);
    expect(mocks.from).toHaveBeenNthCalledWith(1, "linkedin-draft-media");
    expect(mocks.from).toHaveBeenNthCalledWith(2, "linkedin-draft-media");
    expect(mocks.from).toHaveBeenNthCalledWith(3, "linkedin-draft-media");
    expect(mocks.from).toHaveBeenNthCalledWith(4, "linkedin-draft-media");
    expect(mocks.upload).toHaveBeenCalledWith(objectPath, bytes, {
      contentType: "image/png",
      upsert: false
    });
    expect(mocks.download).toHaveBeenCalledWith(objectPath);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(objectPath, 900);
    expect(mocks.remove).toHaveBeenCalledWith([objectPath]);

    const serializedFactoryCall = JSON.stringify(mocks.clientFactory.mock.calls[0]);
    expect(serializedFactoryCall).not.toMatch(/service[_-]?role|secret[_-]?key/i);
  });

  it("binds each adapter instance to that request's JWT", async () => {
    const nextAccessToken = "next-request-user-jwt";
    const first = await createStorage();
    const second = await createStorage(config, { subject, accessToken: nextAccessToken });

    await first.download(objectPath);
    await second.download(objectPath);

    expect(mocks.clientFactory).toHaveBeenNthCalledWith(1, url, publishableKey, expect.objectContaining({
      global: { headers: { Authorization: `Bearer ${accessToken}` } }
    }));
    expect(mocks.clientFactory).toHaveBeenNthCalledWith(2, url, publishableKey, expect.objectContaining({
      global: { headers: { Authorization: `Bearer ${nextAccessToken}` } }
    }));
  });

  it("rejects cross-subject paths before selecting a Supabase bucket", async () => {
    const storage = await createStorage();
    const otherPath = `other-${subject}/a1/media-id/image.png`;
    const actions = [
      () => storage.upload(otherPath, Uint8Array.of(1), "image/jpeg"),
      () => storage.download(otherPath),
      () => storage.createSignedUrl(otherPath, 60),
      () => storage.remove([objectPath, otherPath])
    ];

    for (const action of actions) {
      await expectSafeStorageError(action);
    }

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("accepts signed URL lifetimes only at integer seconds from 1 through 900", async () => {
    const storage = await createStorage();

    for (const invalidLifetime of [-1, 0, 1.5, 901, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expectSafeStorageError(() => storage.createSignedUrl(objectPath, invalidLifetime));
    }
    expect(mocks.from).not.toHaveBeenCalled();

    await expect(storage.createSignedUrl(objectPath, 1)).resolves.toContain("token=signed");
    await expect(storage.createSignedUrl(objectPath, 900)).resolves.toContain("token=signed");
    expect(mocks.createSignedUrl).toHaveBeenNthCalledWith(1, objectPath, 1);
    expect(mocks.createSignedUrl).toHaveBeenNthCalledWith(2, objectPath, 900);
  });

  it("converts every Supabase error response to the same body-free domain error", async () => {
    const storage = await createStorage();
    const providerSecret = "private-provider-error-body";
    const providerError = { message: providerSecret, error: providerSecret, statusCode: "403" };
    const cases: ReadonlyArray<{
      mock: typeof mocks.upload;
      action: () => Promise<unknown>;
    }> = [
      {
        mock: mocks.upload,
        action: () => storage.upload(objectPath, Uint8Array.of(1), "image/gif")
      },
      { mock: mocks.download, action: () => storage.download(objectPath) },
      { mock: mocks.createSignedUrl, action: () => storage.createSignedUrl(objectPath, 60) },
      { mock: mocks.remove, action: () => storage.remove([objectPath]) }
    ];

    for (const testCase of cases) {
      testCase.mock.mockResolvedValueOnce({ data: null, error: providerError });
      await expectSafeStorageError(testCase.action, providerSecret);
    }
  });

  it("returns signed URLs only from the exact configured HTTPS origin", async () => {
    const storage = await createStorage();
    const invalidUrls = [
      "https://other-project.supabase.co/storage/v1/object/sign/file?token=private",
      "https://project-ref.supabase.co.evil.example/storage/v1/object/sign/file?token=private",
      "http://project-ref.supabase.co/storage/v1/object/sign/file?token=private",
      "https://user:password@project-ref.supabase.co/storage/v1/object/sign/file?token=private",
      "not-an-absolute-url"
    ];

    for (const signedUrl of invalidUrls) {
      mocks.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl }, error: null });
      await expectSafeStorageError(() => storage.createSignedUrl(objectPath, 60), "private");
    }
  });

  it("fails closed before creating a client when required HTTPS configuration is absent or invalid", async () => {
    const invalidConfigs: StorageConfig[] = [
      { supabasePublishableKey: publishableKey, linkedinMediaBucket: "linkedin-draft-media" },
      { supabaseUrl: url, linkedinMediaBucket: "linkedin-draft-media" },
      {
        supabaseUrl: "http://project-ref.supabase.co",
        supabasePublishableKey: publishableKey,
        linkedinMediaBucket: "linkedin-draft-media"
      },
      {
        supabaseUrl: `${url}/unexpected-path`,
        supabasePublishableKey: publishableKey,
        linkedinMediaBucket: "linkedin-draft-media"
      }
    ];

    for (const invalidConfig of invalidConfigs) {
      await expectSafeStorageError(async () => createSupabaseDraftMediaStorage(invalidConfig, auth));
    }
    expect(mocks.clientFactory).not.toHaveBeenCalled();
  });
});

describe("LinkedIn draft media Storage policy migration", () => {
  it("creates exactly the three idempotent owner-folder policies", () => {
    const createdPolicies = [...policySql.matchAll(/create\s+policy\s+"([^"]+)"/gi)]
      .map((match) => match[1]);

    expect(createdPolicies).toEqual([
      "linkedin draft media select own",
      "linkedin draft media insert own",
      "linkedin draft media delete own"
    ]);
    expect(countMatches(policySql, /\bif\s+not\s+exists\s*\(/gi)).toBe(3);
    expect(countMatches(policySql, /\bfrom\s+pg_policies\b/gi)).toBe(3);
    expect(countMatches(policySql, /\bon\s+storage\.objects\s+for\s+(?:select|insert|delete)\s+to\s+authenticated\b/gi)).toBe(3);
    expect(policySql).toMatch(/create\s+policy\s+"linkedin draft media select own"[\s\S]*?for\s+select[\s\S]*?using\s*\(/i);
    expect(policySql).toMatch(/create\s+policy\s+"linkedin draft media insert own"[\s\S]*?for\s+insert[\s\S]*?with\s+check\s*\(/i);
    expect(policySql).toMatch(/create\s+policy\s+"linkedin draft media delete own"[\s\S]*?for\s+delete[\s\S]*?using\s*\(/i);
  });

  it("restricts every policy to the exact bucket and cached authenticated subject folder", () => {
    expect(countMatches(policySql, /bucket_id\s*=\s*'linkedin-draft-media'/gi)).toBe(3);
    expect(countMatches(
      policySql,
      /\(storage\.foldername\(name\)\)\[1\]\s*=\s*\(select\s+auth\.uid\(\)\)::text/gi
    )).toBe(3);
  });

  it("does not create the bucket, grant UPDATE, or mutate Supabase Storage data or schema", () => {
    expect(policySql).not.toMatch(/insert\s+into\s+storage\.(?:buckets|objects)/i);
    expect(policySql).not.toMatch(/update\s+storage\.(?:buckets|objects)\s+set/i);
    expect(policySql).not.toMatch(/delete\s+from\s+storage\.(?:buckets|objects)/i);
    expect(policySql).not.toMatch(/\bstorage\.buckets\b/i);
    expect(policySql).not.toMatch(/\bfor\s+update\b/i);
    expect(policySql).not.toMatch(/\b(?:create|alter|drop)\s+(?:table|function|index)\b/i);
  });
});
