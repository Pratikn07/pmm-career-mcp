import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createLinkedInConnectionPreflight } from "../../src/index.js";
import { createImagePublishService } from "../../src/linkedin/image-publish-service.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import { createReviewService } from "../../src/posts/review-service.js";
import { createTestDatabase } from "../support/database.js";

const db = await createTestDatabase();

afterEach(async () => db.resetForTests());
afterAll(async () => db.close());

it("rejects malformed encrypted production credentials before the composed publish claim", async () => {
  const subject = "123e4567-e89b-12d3-a456-426614174000";
  const created = await db.postDrafts.createVersionWithMedia({
    text: "Credential preflight must happen first",
    visibility: "CONNECTIONS",
    state: "draft",
    media: [],
    checksum: (version, draftId) => checksumLinkedInPost({
      draftId,
      version,
      text: "Credential preflight must happen first",
      visibility: "CONNECTIONS",
      media: []
    })
  });
  const storage = {
    upload: vi.fn(), download: vi.fn(), remove: vi.fn(),
    createSignedUrl: vi.fn(async () => "https://example.test/signed")
  };
  const preview = await createReviewService(db, {
    subject,
    storage,
    randomBytes: () => Buffer.alloc(32, 7)
  }).createExact(created.post.draftId, created.post.version);
  await db.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: "not-an-encrypted-envelope",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const external = {
    initializeImage: vi.fn(),
    uploadImage: vi.fn(),
    createPost: vi.fn()
  };
  const preflight = createLinkedInConnectionPreflight(db, {
    tokenEncryptionKey: "a".repeat(64),
    publishingClientAvailable: true
  });
  const publish = createImagePublishService(db, {
    subject,
    storage,
    client: external,
    publishEnabled: true,
    imagePublishEnabled: true,
    connectionValid: preflight
  });

  await expect(publish.publish(preview.approvalCapability)).rejects.toMatchObject({
    code: "OAUTH_PROVIDER_ERROR"
  });
  expect((await db.previews.listForPostDraft(created.post.id))[0]?.consumedAt).toBeNull();
  expect(await db.publishAttempts.listForPostDraft(created.post.id)).toEqual([]);
  expect(external.initializeImage).not.toHaveBeenCalled();
  expect(external.uploadImage).not.toHaveBeenCalled();
  expect(external.createPost).not.toHaveBeenCalled();
});

it("is false when the real publishing adapter or encryption key is unavailable", async () => {
  await expect(createLinkedInConnectionPreflight(db, {
    publishingClientAvailable: false
  })()).resolves.toBe(false);
});
