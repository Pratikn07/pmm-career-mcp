import { createClient } from "@supabase/supabase-js";
import type { RequestAuthContext } from "../auth/request-context.js";
import type { AppConfig } from "../config.js";
import { DomainError } from "../domain/errors.js";

export type DraftMediaMimeType = "image/jpeg" | "image/png" | "image/gif";

export type DraftMediaStorage = Readonly<{
  upload(path: string, bytes: Uint8Array, mimeType: DraftMediaMimeType): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  remove(paths: readonly string[]): Promise<void>;
}>;

type DraftMediaStorageConfig = Pick<
  AppConfig,
  "supabaseUrl" | "supabasePublishableKey" | "linkedinMediaBucket"
>;

type StorageResult<T> = Readonly<{
  data: T | null;
  error: unknown;
}>;

function mediaStorageError(): DomainError {
  return new DomainError("MEDIA_STORAGE_ERROR", "Draft media storage operation failed");
}

function configuredSupabaseOrigin(config: DraftMediaStorageConfig): {
  publishableKey: string;
  url: string;
  origin: string;
} {
  const { supabasePublishableKey, supabaseUrl } = config;
  if (
    supabaseUrl === undefined
    || supabaseUrl.length === 0
    || supabasePublishableKey === undefined
    || supabasePublishableKey.length === 0
  ) {
    throw mediaStorageError();
  }

  try {
    const parsed = new URL(supabaseUrl);
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin !== supabaseUrl
    ) {
      throw mediaStorageError();
    }
    return { publishableKey: supabasePublishableKey, url: supabaseUrl, origin: parsed.origin };
  } catch {
    throw mediaStorageError();
  }
}

function assertOwnedPath(path: string, subject: string): void {
  if (!path.startsWith(`${subject}/`)) {
    throw mediaStorageError();
  }
}

async function storageRequest<T>(operation: () => PromiseLike<StorageResult<T>>): Promise<T> {
  try {
    const result = await operation();
    if (result.error !== null || result.data === null) {
      throw mediaStorageError();
    }
    return result.data;
  } catch {
    throw mediaStorageError();
  }
}

export function createSupabaseDraftMediaStorage(
  config: DraftMediaStorageConfig,
  auth: RequestAuthContext
): DraftMediaStorage {
  const supabaseConfig = configuredSupabaseOrigin(config);
  const client = createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
    global: { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  return {
    async upload(path, bytes, mimeType): Promise<void> {
      assertOwnedPath(path, auth.subject);
      await storageRequest(() => client.storage
        .from(config.linkedinMediaBucket)
        .upload(path, bytes, { contentType: mimeType, upsert: false }));
    },

    async download(path): Promise<Uint8Array> {
      assertOwnedPath(path, auth.subject);
      const blob = await storageRequest(() => client.storage
        .from(config.linkedinMediaBucket)
        .download(path));
      try {
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        throw mediaStorageError();
      }
    },

    async createSignedUrl(path, expiresInSeconds): Promise<string> {
      assertOwnedPath(path, auth.subject);
      if (
        !Number.isInteger(expiresInSeconds)
        || expiresInSeconds < 1
        || expiresInSeconds > 900
      ) {
        throw mediaStorageError();
      }

      const data = await storageRequest(() => client.storage
        .from(config.linkedinMediaBucket)
        .createSignedUrl(path, expiresInSeconds));
      try {
        const signedUrl = new URL(data.signedUrl);
        if (
          signedUrl.protocol !== "https:"
          || signedUrl.origin !== supabaseConfig.origin
          || signedUrl.username !== ""
          || signedUrl.password !== ""
        ) {
          throw mediaStorageError();
        }
        return data.signedUrl;
      } catch {
        throw mediaStorageError();
      }
    },

    async remove(paths): Promise<void> {
      for (const path of paths) {
        assertOwnedPath(path, auth.subject);
      }
      await storageRequest(() => client.storage
        .from(config.linkedinMediaBucket)
        .remove([...paths]));
    }
  };
}
