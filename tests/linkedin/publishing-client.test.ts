import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import nock from "nock";
import { createLinkedInPublishingClient } from "../../src/linkedin/publishing-client.js";
import { encryptJson } from "../../src/security/crypto.js";
import { createTestDatabase } from "../support/database.js";

const KEY = "c".repeat(64);
const ACCESS_TOKEN = "linkedin-test-access-token";
const AUTHOR_URN = "urn:li:person:person-123";
const VERSION = "202606";
const db = await createTestDatabase();

afterEach(async () => {
  await db.resetForTests();
  nock.cleanAll();
});
afterAll(async () => db.close());

async function client(fetch?: typeof globalThis.fetch) {
  await db.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: JSON.stringify(encryptJson({
      accessToken: ACCESS_TOKEN,
      authorUrn: AUTHOR_URN
    }, KEY)),
    expiresAt: "2030-07-17T13:00:00.000Z"
  });
  return createLinkedInPublishingClient(db, {
    tokenEncryptionKey: KEY,
    linkedinVersion: VERSION,
    ...(fetch === undefined ? {} : { fetch })
  });
}

describe("one-shot LinkedIn image publishing transport", () => {
  it("initializes one person-owned image with the exact versioned request and never GETs Images", async () => {
    const scope = nock("https://api.linkedin.com", {
      reqheaders: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "linkedin-version": VERSION,
        "x-restli-protocol-version": "2.0.0"
      }
    })
      .post("/rest/images", {
        initializeUploadRequest: { owner: AUTHOR_URN }
      })
      .query({ action: "initializeUpload" })
      .once()
      .reply(200, {
        value: {
          uploadUrl: "https://www.linkedin.com/dms-uploads/image-123",
          image: "urn:li:image:image_123-A"
        }
      });

    await expect((await client()).initializeImage()).resolves.toEqual({
      outcome: "ready",
      imageUrn: "urn:li:image:image_123-A",
      uploadUrl: "https://www.linkedin.com/dms-uploads/image-123"
    });
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it.each([
    "https://linkedin.com/upload",
    "https://media.linkedin.com/upload",
    "https://licdn.com/upload",
    "https://media.licdn.com/upload",
    "https://MEDIA.LICDN.COM/upload"
  ])("accepts a normalized LinkedIn upload hostname: %s", async (uploadUrl) => {
    const expectedUrl = new URL(uploadUrl);
    const scope = nock(expectedUrl.origin)
      .put(expectedUrl.pathname, Buffer.from([0, 1, 2, 255]))
      .matchHeader("authorization", `Bearer ${ACCESS_TOKEN}`)
      .matchHeader("content-type", "image/png")
      .once()
      .reply(201);

    await expect((await client()).uploadImage({
      uploadUrl,
      bytes: new Uint8Array([0, 1, 2, 255]),
      mimeType: "image/png"
    })).resolves.toEqual({ outcome: "uploaded" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([
    "http://media.linkedin.com/upload",
    "https://linkedin.com.evil.test/upload",
    "https://notlinkedin.com/upload",
    "https://licdn.com.evil.test/upload",
    "https://evil.test/upload",
    "not a URL"
  ])("rejects an unsafe upload URL without dispatch: %s", async (uploadUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect((await client(fetch)).uploadImage({
      uploadUrl,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg"
    })).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns unknown for missing or malformed initialize fields and never follows the upload URL", async () => {
    const responses = [
      { value: { uploadUrl: "https://media.licdn.com/upload" } },
      { value: { image: "urn:li:image:image-1" } },
      { value: { uploadUrl: "https://evil.test/upload", image: "urn:li:image:image-1" } },
      { value: { uploadUrl: "https://media.licdn.com/upload", image: "urn:li:image:bad/value" } }
    ];

    for (const response of responses) {
      const scope = nock("https://api.linkedin.com")
        .post("/rest/images")
        .query({ action: "initializeUpload" })
        .once()
        .reply(200, response);

      await expect((await client()).initializeImage()).resolves.toEqual({ outcome: "unknown" });
      expect(scope.isDone()).toBe(true);
    }
  });

  it("does not follow an initialize redirect or dispatch a second request", async () => {
    let redirectTargetReached = false;
    const original = nock("https://api.linkedin.com")
      .post("/rest/images")
      .query({ action: "initializeUpload" })
      .once()
      .reply(307, undefined, { location: "https://unapproved.example/initialize" });
    nock("https://unapproved.example")
      .post("/initialize", () => {
        redirectTargetReached = true;
        return true;
      })
      .reply(200, {
        value: {
          uploadUrl: "https://upload.licdn.com/image",
          image: "urn:li:image:redirected"
        }
      });

    await expect((await client()).initializeImage()).resolves.toEqual({ outcome: "unknown" });
    expect(original.isDone()).toBe(true);
    expect(redirectTargetReached).toBe(false);
  });

  it("sets manual redirect handling on the single initialize request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, {
      status: 307,
      headers: { location: "https://unapproved.example/initialize" }
    }));

    await expect((await client(fetch)).initializeImage()).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it.each([307, 308])("does not follow upload redirect %i or forward bytes to an unapproved host", async (status) => {
    const bytes = Buffer.from([19, 27, 31, 255]);
    let redirectTargetReached = false;
    const original = nock("https://upload.linkedin.com")
      .put("/redirect", bytes)
      .once()
      .reply(status, undefined, { location: "https://unapproved.example/stolen" });
    nock("https://unapproved.example")
      .put("/stolen", (body) => {
        redirectTargetReached = true;
        return Buffer.isBuffer(body) && body.equals(bytes);
      })
      .reply(201);

    await expect((await client()).uploadImage({
      uploadUrl: "https://upload.linkedin.com/redirect",
      bytes,
      mimeType: "image/png"
    })).resolves.toEqual({ outcome: "unknown" });
    expect(original.isDone()).toBe(true);
    expect(redirectTargetReached).toBe(false);
  });

  it("sets manual redirect handling on the single byte-upload request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, {
      status: 308,
      headers: { location: "https://unapproved.example/stolen" }
    }));

    await expect((await client(fetch)).uploadImage({
      uploadUrl: "https://upload.linkedin.com/image",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg"
    })).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("uploads the exact bytes once and does not retry an ambiguous upload", async () => {
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 255]);
    const scope = nock("https://upload.linkedin.com")
      .put("/exact", Buffer.from(bytes))
      .matchHeader("authorization", `Bearer ${ACCESS_TOKEN}`)
      .matchHeader("content-type", "image/gif")
      .once()
      .reply(503, { message: "temporary" });

    await expect((await client()).uploadImage({
      uploadUrl: "https://upload.linkedin.com/exact",
      bytes,
      mimeType: "image/gif"
    })).resolves.toEqual({ outcome: "unknown" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([400, 401, 403, 422])("classifies initialize status %i as a definite failure", async (status) => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/images")
      .query({ action: "initializeUpload" })
      .once()
      .reply(status, { access_token: "must-not-be-returned" });

    await expect((await client()).initializeImage()).resolves.toEqual({ outcome: "definite_failure" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([400, 401, 403, 422])("classifies upload status %i as a definite failure", async (status) => {
    const scope = nock("https://upload.licdn.com")
      .put("/image")
      .once()
      .reply(status, { access_token: "must-not-be-returned" });

    await expect((await client()).uploadImage({
      uploadUrl: "https://upload.licdn.com/image",
      bytes: new Uint8Array([1]),
      mimeType: "image/jpeg"
    })).resolves.toEqual({ outcome: "definite_failure" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([429, 500, 503])("classifies initialize status %i as unknown with no retry", async (status) => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/images")
      .query({ action: "initializeUpload" })
      .once()
      .reply(status);

    await expect((await client()).initializeImage()).resolves.toEqual({ outcome: "unknown" });
    expect(scope.isDone()).toBe(true);
  });

  it("classifies a transport throw as unknown without exposing or retrying it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`timeout Authorization: Bearer ${ACCESS_TOKEN}`)
    );
    const publishingClient = await client(fetch);

    await expect(publishingClient.initializeImage()).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies an upload transport throw as unknown without retrying it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`socket reset Authorization: Bearer ${ACCESS_TOKEN}`)
    );
    const publishingClient = await client(fetch);

    await expect(publishingClient.uploadImage({
      uploadUrl: "https://upload.licdn.com/image",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg"
    })).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates a text-only post with no content field and one final request", async () => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts", (body) => body.author === AUTHOR_URN && !("content" in body))
      .once()
      .reply(201, undefined, { "x-restli-id": "urn:li:share:100" });

    await expect((await client()).createPost({
      text: "Text only",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "published", postUrn: "urn:li:share:100" });
    expect(scope.isDone()).toBe(true);
  });

  it("creates an exact single-image post with content.media", async () => {
    const scope = nock("https://api.linkedin.com", {
      reqheaders: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
        "linkedin-version": VERSION,
        "x-restli-protocol-version": "2.0.0"
      }
    })
      .post("/rest/posts", {
        author: AUTHOR_URN,
        commentary: "One image",
        visibility: "CONNECTIONS",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: []
        },
        content: {
          media: { id: "urn:li:image:image-one", altText: "Exact alt text" }
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false
      })
      .once()
      .reply(201, undefined, { "x-restli-id": "urn:li:ugcPost:101" });

    await expect((await client()).createPost({
      text: "One image",
      visibility: "CONNECTIONS",
      media: [{ imageUrn: "urn:li:image:image-one", altText: "Exact alt text" }]
    })).resolves.toEqual({ outcome: "published", postUrn: "urn:li:ugcPost:101" });
    expect(scope.isDone()).toBe(true);
  });

  it("creates one multi-image post preserving image and alt-text order", async () => {
    const media = [
      { imageUrn: "urn:li:image:first", altText: "First image" },
      { imageUrn: "urn:li:image:second", altText: "Second image" },
      { imageUrn: "urn:li:image:third", altText: "Third image" },
      { imageUrn: "urn:li:image:fourth", altText: "Fourth image" }
    ] as const;
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts", (body) => JSON.stringify(body.content) === JSON.stringify({
        multiImage: {
          images: media.map(({ imageUrn, altText }) => ({ id: imageUrn, altText }))
        }
      }))
      .once()
      .reply(201, undefined, { "x-restli-id": "urn:li:share:102" });

    await expect((await client()).createPost({
      text: "Four ordered images",
      visibility: "PUBLIC",
      media
    })).resolves.toEqual({ outcome: "published", postUrn: "urn:li:share:102" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([400, 401, 403, 422])("classifies final post status %i as a definite failure", async (status) => {
    const scope = nock("https://api.linkedin.com").post("/rest/posts").once().reply(status);
    await expect((await client()).createPost({
      text: "Rejected",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "definite_failure" });
    expect(scope.isDone()).toBe(true);
  });

  it.each([429, 500, 503])("classifies final post status %i as unknown with one request", async (status) => {
    const scope = nock("https://api.linkedin.com").post("/rest/posts").once().reply(status);
    await expect((await client()).createPost({
      text: "Ambiguous",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "unknown" });
    expect(scope.isDone()).toBe(true);
  });

  it("treats successful final status without a valid x-restli-id as unknown", async () => {
    for (const postUrn of [undefined, "", "urn:li:image:not-a-post", "urn:li:share:not-numeric"]) {
      const scope = nock("https://api.linkedin.com")
        .post("/rest/posts")
        .once()
        .reply(201, undefined, postUrn === undefined ? {} : { "x-restli-id": postUrn });
      await expect((await client()).createPost({
        text: "Missing result",
        visibility: "PUBLIC",
        media: []
      })).resolves.toEqual({ outcome: "unknown" });
      expect(scope.isDone()).toBe(true);
    }
  });

  it("classifies a final-post transport throw as unknown without retrying it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`timeout Authorization: Bearer ${ACCESS_TOKEN}`)
    );
    const publishingClient = await client(fetch);

    await expect(publishingClient.createPost({
      text: "Unknown final result",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not follow a final-post redirect or dispatch a second publish request", async () => {
    let redirectTargetReached = false;
    const original = nock("https://api.linkedin.com")
      .post("/rest/posts")
      .once()
      .reply(308, undefined, { location: "https://unapproved.example/posts" });
    nock("https://unapproved.example")
      .post("/posts", () => {
        redirectTargetReached = true;
        return true;
      })
      .reply(201, undefined, { "x-restli-id": "urn:li:share:999" });

    await expect((await client()).createPost({
      text: "Never redirect this post",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "unknown" });
    expect(original.isDone()).toBe(true);
    expect(redirectTargetReached).toBe(false);
  });

  it("sets manual redirect handling on the single final-post request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(undefined, {
      status: 307,
      headers: { location: "https://unapproved.example/posts" }
    }));

    await expect((await client(fetch)).createPost({
      text: "One final post request",
      visibility: "PUBLIC",
      media: []
    })).resolves.toEqual({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("rejects malformed image URNs and more than four images before the final request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const publishingClient = await client(fetch);
    const valid = { imageUrn: "urn:li:image:valid", altText: "Alt" };

    await expect(publishingClient.createPost({
      text: "Bad URN",
      visibility: "PUBLIC",
      media: [{ imageUrn: "urn:li:image:bad/value", altText: "Alt" }]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(publishingClient.createPost({
      text: "Five images",
      visibility: "PUBLIC",
      media: [valid, valid, valid, valid, valid]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1, 4])("rejects a sparse %i-slot media array before credential load or dispatch", async (length) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const publishingClient = await client(fetch);
    const credentialLookup = vi.spyOn(db.oauthTokens, "getByProvider");
    const sparseMedia = new Array(length) as Array<{ imageUrn: string; altText: string }>;

    await expect(publishingClient.createPost({
      text: "Sparse media must fail closed",
      visibility: "PUBLIC",
      media: sparseMedia
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(credentialLookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
