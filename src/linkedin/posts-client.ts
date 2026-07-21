import type { CareerDatabase } from "../db/client.js";
import type { PostVisibility } from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import { decryptJson, type EncryptedEnvelope } from "../security/crypto.js";

const POSTS_ENDPOINT = "https://api.linkedin.com/rest/posts";
const ALLOWED_VISIBILITIES: ReadonlySet<string> = new Set(["PUBLIC", "CONNECTIONS"]);

export type StoredLinkedInCredential = Readonly<{ accessToken: string; authorUrn: string }>;

export type LinkedInPostMedia = Readonly<{
  imageUrn: string;
  altText: string;
}>;

export type LinkedInPostCreateInput = Readonly<{
  text: string;
  visibility: PostVisibility;
  media: readonly LinkedInPostMedia[];
}>;

export type LinkedInPostsClientDependencies = {
  tokenEncryptionKey: string;
  linkedinVersion: string;
  fetch?: typeof globalThis.fetch;
};

export type LinkedInPostCreateResult =
  | Readonly<{ status: number; postUrn: string }>
  | Readonly<{ status: number }>;

function credentialError(): DomainError {
  return new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization must be reconnected");
}

function parseCredential(value: unknown): StoredLinkedInCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw credentialError();
  }
  const credential = value as Record<string, unknown>;
  if (
    typeof credential.accessToken !== "string"
    || credential.accessToken.length === 0
    || typeof credential.authorUrn !== "string"
    || !/^urn:li:person:[A-Za-z0-9_-]+$/.test(credential.authorUrn)
  ) {
    throw credentialError();
  }
  return { accessToken: credential.accessToken, authorUrn: credential.authorUrn };
}

function parseEnvelope(value: string): EncryptedEnvelope {
  try {
    return JSON.parse(value) as EncryptedEnvelope;
  } catch {
    throw credentialError();
  }
}

export async function loadLinkedInCredential(
  database: CareerDatabase,
  encryptionKey: string
): Promise<StoredLinkedInCredential> {
  let stored;
  try {
    stored = await database.oauthTokens.getByProvider("linkedin");
  } catch {
    throw credentialError();
  }
  if (stored === undefined) {
    throw credentialError();
  }
  if (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= Date.now()) {
    throw credentialError();
  }
  try {
    return parseCredential(decryptJson(parseEnvelope(stored.ciphertext), encryptionKey));
  } catch {
    throw credentialError();
  }
}

function validVersion(value: string): boolean {
  return /^\d{6}$/.test(value);
}

function validImageUrn(value: string): boolean {
  return /^urn:li:image:[A-Za-z0-9_-]+$/.test(value);
}

function validAltText(value: string): boolean {
  const length = [...value].length;
  return length >= 1 && length <= 120;
}

function isDenseMediaArray(media: readonly LinkedInPostMedia[]): boolean {
  for (let index = 0; index < media.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(media, index)) {
      return false;
    }
  }
  return true;
}

function validatePostInput(input: LinkedInPostCreateInput): void {
  if (
    typeof input?.text !== "string"
    || input.text.length === 0
    || !ALLOWED_VISIBILITIES.has(input.visibility)
    || !Array.isArray(input.media)
    || input.media.length > 4
    || !isDenseMediaArray(input.media)
    || input.media.some((media) => (
      typeof media !== "object"
      || media === null
      || !validImageUrn(media.imageUrn)
      || !validAltText(media.altText)
    ))
  ) {
    throw new DomainError("VALIDATION_ERROR", "LinkedIn post input is invalid");
  }
}

function contentFor(media: readonly LinkedInPostMedia[]): Record<string, unknown> | undefined {
  if (media.length === 0) {
    return undefined;
  }
  if (media.length === 1) {
    const image = media[0]!;
    return { media: { id: image.imageUrn, altText: image.altText } };
  }
  return {
    multiImage: {
      images: media.map(({ imageUrn, altText }) => ({ id: imageUrn, altText }))
    }
  };
}

/** A one-shot adapter for the official, versioned LinkedIn Posts API. */
export function createLinkedInPostsClient(
  database: CareerDatabase,
  dependencies: LinkedInPostsClientDependencies
) {
  if (!validVersion(dependencies.linkedinVersion)) {
    throw new DomainError("VALIDATION_ERROR", "LinkedIn API version is invalid");
  }
  const fetch = dependencies.fetch ?? globalThis.fetch;

  async function createPost(input: LinkedInPostCreateInput): Promise<LinkedInPostCreateResult> {
    validatePostInput(input);
    const credential = await loadLinkedInCredential(database, dependencies.tokenEncryptionKey);
    const content = contentFor(input.media);
    let response: Response;
    try {
      response = await fetch(POSTS_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
          "linkedin-version": dependencies.linkedinVersion,
          "x-restli-protocol-version": "2.0.0"
        },
        body: JSON.stringify({
          author: credential.authorUrn,
          commentary: input.text,
          visibility: input.visibility,
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: []
          },
          ...(content === undefined ? {} : { content }),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false
        })
      });
    } catch {
      // The request may have reached LinkedIn; callers must treat this as unknown.
      return { status: 0 };
    }
    const postUrn = response.headers.get("x-restli-id");
    if (
      response.status >= 200
      && response.status < 300
      && postUrn !== null
      && /^urn:li:(?:share|ugcPost):[0-9]+$/.test(postUrn)
    ) {
      return { status: response.status, postUrn };
    }
    return { status: response.status };
  }

  async function createTextPost(input: { text: string; visibility: PostVisibility }): Promise<LinkedInPostCreateResult> {
    return createPost({ ...input, media: [] });
  }

  return { createPost, createTextPost };
}
