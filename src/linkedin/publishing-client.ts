import type { CareerDatabase } from "../db/client.js";
import { DomainError } from "../domain/errors.js";
import type { DraftMediaMimeType } from "../media/storage.js";
import {
  createLinkedInPostsClient,
  loadLinkedInCredential,
  type LinkedInPostsClientDependencies
} from "./posts-client.js";

const IMAGES_ENDPOINT = "https://api.linkedin.com/rest/images?action=initializeUpload";
const IMAGE_URN_PATTERN = /^urn:li:image:[A-Za-z0-9_-]+$/;
const POST_URN_PATTERN = /^urn:li:(?:share|ugcPost):[0-9]+$/;
const DEFINITE_FAILURE_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 422]);
const MEDIA_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif"]);

export type LinkedInInitializeImageResult =
  | { outcome: "ready"; imageUrn: string; uploadUrl: string }
  | { outcome: "definite_failure" }
  | { outcome: "unknown" };

export type LinkedInUploadImageResult =
  | { outcome: "uploaded" }
  | { outcome: "definite_failure" }
  | { outcome: "unknown" };

export type LinkedInCreatePostResult =
  | { outcome: "published"; postUrn: string }
  | { outcome: "definite_failure" }
  | { outcome: "unknown" };

export type LinkedInPublishingClient = Readonly<{
  initializeImage(): Promise<LinkedInInitializeImageResult>;
  uploadImage(input: {
    uploadUrl: string;
    bytes: Uint8Array;
    mimeType: DraftMediaMimeType;
  }): Promise<LinkedInUploadImageResult>;
  createPost(input: {
    text: string;
    visibility: "PUBLIC" | "CONNECTIONS";
    media: readonly { imageUrn: string; altText: string }[];
  }): Promise<LinkedInCreatePostResult>;
}>;

function isDefiniteFailure(status: number): boolean {
  return DEFINITE_FAILURE_STATUSES.has(status);
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function normalizedAllowedUploadUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  const allowedHostname = hostname === "linkedin.com"
    || hostname.endsWith(".linkedin.com")
    || hostname === "licdn.com"
    || hostname.endsWith(".licdn.com");
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || !allowedHostname
  ) {
    return undefined;
  }
  return value;
}

function parseInitializeResponse(value: unknown): { imageUrn: string; uploadUrl: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  if (typeof root.value !== "object" || root.value === null || Array.isArray(root.value)) {
    return undefined;
  }
  const result = root.value as Record<string, unknown>;
  const uploadUrl = normalizedAllowedUploadUrl(result.uploadUrl);
  if (
    typeof result.image !== "string"
    || !IMAGE_URN_PATTERN.test(result.image)
    || uploadUrl === undefined
  ) {
    return undefined;
  }
  return { imageUrn: result.image, uploadUrl };
}

function uploadInputIsValid(input: {
  uploadUrl: string;
  bytes: Uint8Array;
  mimeType: DraftMediaMimeType;
}): boolean {
  return input.bytes instanceof Uint8Array
    && input.bytes.byteLength > 0
    && MEDIA_MIME_TYPES.has(input.mimeType);
}

/** A no-retry adapter for LinkedIn's versioned Images and Posts APIs. */
export function createLinkedInPublishingClient(
  database: CareerDatabase,
  dependencies: LinkedInPostsClientDependencies
): LinkedInPublishingClient {
  const posts = createLinkedInPostsClient(database, dependencies);
  const fetch = dependencies.fetch ?? globalThis.fetch;

  const client: LinkedInPublishingClient = {
    async initializeImage(): Promise<LinkedInInitializeImageResult> {
      const credential = await loadLinkedInCredential(database, dependencies.tokenEncryptionKey);
      let response: Response;
      try {
        response = await fetch(IMAGES_ENDPOINT, {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": "application/json",
            "linkedin-version": dependencies.linkedinVersion,
            "x-restli-protocol-version": "2.0.0"
          },
          body: JSON.stringify({
            initializeUploadRequest: { owner: credential.authorUrn }
          })
        });
      } catch {
        return { outcome: "unknown" };
      }
      if (isDefiniteFailure(response.status)) {
        return { outcome: "definite_failure" };
      }
      if (!isSuccessful(response.status)) {
        return { outcome: "unknown" };
      }
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        return { outcome: "unknown" };
      }
      const initialized = parseInitializeResponse(parsedBody);
      return initialized === undefined
        ? { outcome: "unknown" }
        : { outcome: "ready", ...initialized };
    },

    async uploadImage(input): Promise<LinkedInUploadImageResult> {
      const uploadUrl = normalizedAllowedUploadUrl(input?.uploadUrl);
      if (uploadUrl === undefined) {
        return { outcome: "unknown" };
      }
      if (!uploadInputIsValid(input)) {
        throw new DomainError("VALIDATION_ERROR", "LinkedIn image upload input is invalid");
      }
      const credential = await loadLinkedInCredential(database, dependencies.tokenEncryptionKey);
      let response: Response;
      try {
        response = await fetch(uploadUrl, {
          method: "PUT",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": input.mimeType
          },
          body: Buffer.from(input.bytes)
        });
      } catch {
        return { outcome: "unknown" };
      }
      if (isSuccessful(response.status)) {
        return { outcome: "uploaded" };
      }
      return isDefiniteFailure(response.status)
        ? { outcome: "definite_failure" }
        : { outcome: "unknown" };
    },

    async createPost(input): Promise<LinkedInCreatePostResult> {
      const response = await posts.createPost(input);
      if (
        isSuccessful(response.status)
        && "postUrn" in response
        && POST_URN_PATTERN.test(response.postUrn)
      ) {
        return { outcome: "published", postUrn: response.postUrn };
      }
      return isDefiniteFailure(response.status)
        ? { outcome: "definite_failure" }
        : { outcome: "unknown" };
    }
  };
  return Object.freeze(client);
}
