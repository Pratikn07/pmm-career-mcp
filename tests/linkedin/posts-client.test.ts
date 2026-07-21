import { afterAll, afterEach, describe, expect, it } from "vitest";
import nock from "nock";
import { createTestDatabase } from "../support/database.js";
import { encryptJson } from "../../src/security/crypto.js";
import { createLinkedInPostsClient } from "../../src/linkedin/posts-client.js";

const KEY = "b".repeat(64);
const db = await createTestDatabase();

afterEach(async () => {
  (await db.resetForTests());
  nock.cleanAll();
});
afterAll(async () => (await db.close()));

async function client(fetch?: typeof globalThis.fetch) {
  (await db.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: JSON.stringify(encryptJson({
      accessToken: "access-token-that-must-not-leak",
      authorUrn: "urn:li:person:person-123"
    }, KEY)),
    expiresAt: "2030-07-17T13:00:00.000Z"
  }));
  return createLinkedInPostsClient(db, {
    tokenEncryptionKey: KEY,
    linkedinVersion: "202607",
    ...(fetch === undefined ? {} : { fetch })
  });
}

describe("versioned LinkedIn Posts API client", () => {
  it("sends one official Posts API request with versioned headers and the documented text payload", async () => {
    const expected = {
      author: "urn:li:person:person-123",
      commentary: "A safe text-only post",
      visibility: "CONNECTIONS",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    };
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts", expected)
      .matchHeader("authorization", "Bearer access-token-that-must-not-leak")
      .matchHeader("linkedin-version", "202607")
      .matchHeader("x-restli-protocol-version", "2.0.0")
      .reply(201, undefined, { "x-restli-id": "urn:li:share:123" });

    await expect((await client()).createTextPost({
      text: "A safe text-only post",
      visibility: "CONNECTIONS"
    })).resolves.toEqual({ status: 201, postUrn: "urn:li:share:123" });
    expect(scope.isDone()).toBe(true);
  });

  it("returns no post URN when LinkedIn omits x-restli-id", async () => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts")
      .reply(201);

    await expect((await client()).createTextPost({ text: "No ID", visibility: "PUBLIC" })).resolves.toEqual({
      status: 201
    });
    expect(scope.isDone()).toBe(true);
  });

  it("makes no internal retry for a dispatched create request", async () => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts")
      .once()
      .reply(503, { error: "temporary" });

    await expect((await client()).createTextPost({ text: "One request", visibility: "PUBLIC" })).resolves.toEqual({
      status: 503
    });
    expect(scope.isDone()).toBe(true);
  });

  it("returns an ambiguous-safe result instead of exposing a transport error", async () => {
    const privateValue = "Bearer access-token-that-must-not-leak";
    const fetch = async (): Promise<Response> => {
      throw new Error(`timeout ${privateValue}`);
    };

    await expect((await client(fetch)).createTextPost({ text: "Timeout", visibility: "PUBLIC" })).resolves.toEqual({
      status: 0
    });
  });

  it("preserves the generic transport result while supporting ordered image content", async () => {
    const scope = nock("https://api.linkedin.com")
      .post("/rest/posts", (body) => JSON.stringify(body.content) === JSON.stringify({
        multiImage: {
          images: [
            { id: "urn:li:image:first", altText: "First" },
            { id: "urn:li:image:second", altText: "Second" }
          ]
        }
      }))
      .once()
      .reply(201, undefined, { "x-restli-id": "urn:li:share:321" });

    await expect((await client()).createPost({
      text: "Two images",
      visibility: "PUBLIC",
      media: [
        { imageUrn: "urn:li:image:first", altText: "First" },
        { imageUrn: "urn:li:image:second", altText: "Second" }
      ]
    })).resolves.toEqual({ status: 201, postUrn: "urn:li:share:321" });
    expect(scope.isDone()).toBe(true);
  });
});
