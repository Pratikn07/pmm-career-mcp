import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CareerDatabase } from "../../src/db/client.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import { createReviewService } from "../../src/posts/review-service.js";
import {
  createImagePublishService,
  type ImagePublishServiceDependencies
} from "../../src/linkedin/image-publish-service.js";
import { createTestDatabase, queryTestDatabase } from "../support/database.js";

const db = await createTestDatabase();
const subject = "123e4567-e89b-12d3-a456-426614174000";
const now = new Date("2026-07-20T12:00:00.000Z");
const clock = () => new Date(now);

afterEach(async () => db.resetForTests());
afterAll(async () => db.close());

type Fixture = Awaited<ReturnType<typeof fixture>>;
let fixtureNonce = 0;

async function fixture(mediaCount: number) {
  fixtureNonce += 1;
  const bytes = Array.from({ length: mediaCount }, (_, index) =>
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, index + 1, fixtureNonce]));
  const media = [];
  for (let position = 0; position < mediaCount; position += 1) {
    const sha256 = createHash("sha256").update(bytes[position]!).digest("hex");
    const row = await db.postMedia.create({
      id: randomUUID(),
      ownerSubject: subject,
      objectPath: `${subject}/${sha256.slice(0, 2)}/${randomUUID()}/image.png`,
      sha256,
      mimeType: "image/png",
      byteSize: bytes[position]!.byteLength,
      width: 1,
      height: 1,
      frameCount: 1,
      originalFilename: "image.png"
    });
    media.push({ mediaId: row.id, altText: `Image ${position + 1}` });
  }
  const created = await db.postDrafts.createVersionWithMedia({
    ownerSubject: subject,
    text: "Exact locked post",
    visibility: "CONNECTIONS",
    state: "draft",
    media,
    checksum: (version, draftId, ordered) => checksumLinkedInPost({
      draftId,
      version,
      text: "Exact locked post",
      visibility: "CONNECTIONS",
      media: ordered.map((item) => ({
        ...item,
        mimeType: item.mimeType as "image/png"
      }))
    })
  });
  const objectBytes = new Map(created.media.map((item, index) => [item.objectPath, bytes[index]!]));
  const preview = await createReviewService(db, {
    subject,
    clock,
    storage: {
      upload: vi.fn(),
      download: vi.fn(),
      remove: vi.fn(),
      createSignedUrl: vi.fn(async (path) => `https://example.test/${encodeURIComponent(path)}`)
    },
    randomBytes: () => Buffer.alloc(32, (fixtureNonce % 254) + 1)
  }).createExact(created.post.draftId, created.post.version);
  return { ...created, bytes, objectBytes, approvalCapability: preview.approvalCapability };
}

function serviceFor(
  value: Fixture,
  overrides: Partial<ImagePublishServiceDependencies> = {},
  database: CareerDatabase = db
) {
  const storage = {
    upload: vi.fn(),
    remove: vi.fn(),
    createSignedUrl: vi.fn(),
    download: vi.fn(async (path: string) => value.objectBytes.get(path)!)
  };
  const client = {
    initializeImage: vi.fn(async () => ({
      outcome: "ready" as const,
      imageUrn: `urn:li:image:${randomUUID().replaceAll("-", "")}`,
      uploadUrl: "https://upload.linkedin.com/image"
    })),
    uploadImage: vi.fn(async (_input: {
      uploadUrl: string;
      bytes: Uint8Array;
      mimeType: "image/jpeg" | "image/png" | "image/gif";
    }) => ({ outcome: "uploaded" as const })),
    createPost: vi.fn(async () => ({ outcome: "published" as const, postUrn: "urn:li:share:123" }))
  };
  const dependencies: ImagePublishServiceDependencies = {
    subject,
    storage,
    client,
    publishEnabled: true,
    imagePublishEnabled: true,
    connectionValid: async () => true,
    clock,
    ...overrides
  };
  return { service: createImagePublishService(database, dependencies), storage, client };
}

function expectCalls(
  value: ReturnType<typeof serviceFor>,
  expected: { downloads: number; initializes: number; uploads: number; posts: number }
) {
  expect(value.storage.download).toHaveBeenCalledTimes(expected.downloads);
  expect(value.client.initializeImage).toHaveBeenCalledTimes(expected.initializes);
  expect(value.client.uploadImage).toHaveBeenCalledTimes(expected.uploads);
  expect(value.client.createPost).toHaveBeenCalledTimes(expected.posts);
}

describe("durable exact LinkedIn publishing", () => {
  it.each([0, 1, 4])("publishes one exact text/gallery snapshot with %i media", async (count) => {
    const value = await fixture(count);
    const runtime = serviceFor(value);

    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "published",
      postUrn: "urn:li:share:123"
    });

    expectCalls(runtime, { downloads: count, initializes: count, uploads: count, posts: 1 });
    for (let position = 0; position < count; position += 1) {
      expect(runtime.client.uploadImage.mock.calls[position]?.[0]).toMatchObject({
        bytes: value.bytes[position],
        mimeType: "image/png"
      });
    }
    expect(runtime.client.createPost).toHaveBeenCalledWith({
      text: value.post.text,
      visibility: value.post.visibility,
      media: value.media.map((item, position) => ({
        imageUrn: expect.stringMatching(/^urn:li:image:/),
        altText: item.altText,
        position
      })).map(({ position: _position, ...item }) => item)
    });
  });

  it("checks both switches and connection before consuming approval", async () => {
    for (const overrides of [
      { publishEnabled: false },
      { imagePublishEnabled: false },
      { connectionValid: async () => false }
    ]) {
      const value = await fixture(1);
      const runtime = serviceFor(value, overrides);
      await expect(runtime.service.publish(value.approvalCapability)).rejects.toBeTruthy();
      expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
      expect((await db.previews.listForPostDraft(value.post.id)).at(-1)?.consumedAt).toBeNull();
    }
  });

  it("allows text-only publishing while the image switch remains disabled", async () => {
    const value = await fixture(0);
    const runtime = serviceFor(value, { imagePublishEnabled: false });
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toMatchObject({
      state: "published"
    });
    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 1 });
  });

  it("consumes approval before side effects and allows only one concurrent sequence", async () => {
    const value = await fixture(1);
    const runtime = serviceFor(value);
    const results = await Promise.allSettled([
      runtime.service.publish(value.approvalCapability),
      runtime.service.publish(value.approvalCapability)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expectCalls(runtime, { downloads: 1, initializes: 1, uploads: 1, posts: 1 });
    expect(await db.publishAttempts.listForPostDraft(value.post.id)).toHaveLength(1);
  });

  it("rolls back capability consumption when the durable attempt snapshot cannot be inserted", async () => {
    const value = await fixture(1);
    const runtime = serviceFor(value);
    await queryTestDatabase(db, `alter table career_mcp.publish_attempts add constraint reject_task11_pending check (response_category <> 'pending')`);
    try {
      await expect(runtime.service.publish(value.approvalCapability)).rejects.toMatchObject({
        code: "DATA_INTEGRITY"
      });
      expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
      expect((await db.previews.listForPostDraft(value.post.id)).at(-1)?.consumedAt).toBeNull();
      expect(await db.publishAttempts.listForPostDraft(value.post.id)).toEqual([]);
      expect(await db.postDrafts.getVersion(value.post.draftId, value.post.version)).toMatchObject({
        state: "previewed"
      });
    } finally {
      await queryTestDatabase(db, `alter table career_mcp.publish_attempts drop constraint reject_task11_pending`);
    }
  });

  it("binds the capability to the authenticated subject", async () => {
    const value = await fixture(0);
    const runtime = serviceFor(value, {
      subject: "123e4567-e89b-12d3-a456-426614174999"
    });
    await expect(runtime.service.publish(value.approvalCapability)).rejects.toMatchObject({
      code: "PREVIEW_INVALID"
    });
    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
  });

  it("rejects a media ownership mismatch before consuming approval", async () => {
    const value = await fixture(1);
    const other = "123e4567-e89b-12d3-a456-426614174999";
    await queryTestDatabase(db, `update career_mcp.post_media set owner_subject = '${other}', object_path = '${other}/aa/${randomUUID()}/image.png' where id = '${value.media[0]!.mediaId}'`);
    const runtime = serviceFor(value);
    await expect(runtime.service.publish(value.approvalCapability)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
    expect((await db.previews.listForPostDraft(value.post.id)).at(-1)?.consumedAt).toBeNull();
  });

  it("rejects expired, replayed, stale, and corrupt-checksum approvals before side effects", async () => {
    const expired = await fixture(0);
    const expiredRuntime = serviceFor(expired, {
      clock: () => new Date(now.getTime() + 15 * 60 * 1_000)
    });
    await expect(expiredRuntime.service.publish(expired.approvalCapability)).rejects.toMatchObject({
      code: "PREVIEW_EXPIRED"
    });
    expectCalls(expiredRuntime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });

    const replayed = await fixture(0);
    const replayRuntime = serviceFor(replayed);
    await replayRuntime.service.publish(replayed.approvalCapability);
    await expect(replayRuntime.service.publish(replayed.approvalCapability)).rejects.toMatchObject({
      code: "PREVIEW_CONSUMED"
    });
    expect(replayRuntime.client.createPost).toHaveBeenCalledTimes(1);

    const stale = await fixture(0);
    await db.postDrafts.createVersionWithMedia({
      draftId: stale.post.draftId,
      expectedVersion: stale.post.version,
      ownerSubject: subject,
      text: "Newer immutable version",
      visibility: "CONNECTIONS",
      state: "draft",
      media: [],
      checksum: (version, draftId) => checksumLinkedInPost({
        draftId, version, text: "Newer immutable version", visibility: "CONNECTIONS", media: []
      })
    });
    const staleRuntime = serviceFor(stale);
    await expect(staleRuntime.service.publish(stale.approvalCapability)).rejects.toMatchObject({
      code: "PREVIEW_STALE"
    });
    expectCalls(staleRuntime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });

    const corrupt = await fixture(0);
    await queryTestDatabase(db, `update career_mcp.post_drafts set checksum = '${"f".repeat(64)}' where id = '${corrupt.post.id}'`);
    const corruptRuntime = serviceFor(corrupt);
    await expect(corruptRuntime.service.publish(corrupt.approvalCapability)).rejects.toMatchObject({
      code: "DATA_INTEGRITY"
    });
    expectCalls(corruptRuntime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
  });

  it("rejects a coherently mutated snapshot against the checksum the user actually previewed", async () => {
    const value = await fixture(1);
    const mutatedText = "Coherently mutated after exact preview";
    const mutatedChecksum = checksumLinkedInPost({
      draftId: value.post.draftId,
      version: value.post.version,
      text: mutatedText,
      visibility: "CONNECTIONS",
      media: value.media.map(({ position, sha256, mimeType, altText }) => ({
        position,
        sha256,
        mimeType: mimeType as "image/png",
        altText
      }))
    });
    await queryTestDatabase(db, `update career_mcp.post_drafts set text = '${mutatedText}', checksum = '${mutatedChecksum}' where id = '${value.post.id}'`);
    const runtime = serviceFor(value);

    await expect(runtime.service.publish(value.approvalCapability)).rejects.toMatchObject({
      code: "DATA_INTEGRITY"
    });

    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
    expect((await db.previews.listForPostDraft(value.post.id)).at(-1)?.consumedAt).toBeNull();
    expect(await db.publishAttempts.listForPostDraft(value.post.id)).toEqual([]);
  });

  it("fails closed on a legacy preview row without a snapshot checksum", async () => {
    const value = await fixture(0);
    await queryTestDatabase(db, `update career_mcp.post_previews set snapshot_checksum = null where post_draft_id = '${value.post.id}'`);
    const runtime = serviceFor(value);

    await expect(runtime.service.publish(value.approvalCapability)).rejects.toMatchObject({
      code: "DATA_INTEGRITY"
    });

    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
    expect((await db.previews.listForPostDraft(value.post.id)).at(-1)?.consumedAt).toBeNull();
  });

  it("stops with media_upload_failed on stored-byte checksum mismatch", async () => {
    const value = await fixture(1);
    value.objectBytes.set(value.media[0]!.objectPath, Uint8Array.from([1, 2, 3]));
    const runtime = serviceFor(value);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_failed"
    });
    expectCalls(runtime, { downloads: 1, initializes: 0, uploads: 0, posts: 0 });
  });

  it("verifies every locked object before any LinkedIn write", async () => {
    const value = await fixture(2);
    value.objectBytes.set(value.media[1]!.objectPath, Uint8Array.from([9, 9, 9]));
    const runtime = serviceFor(value);

    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_failed"
    });

    expectCalls(runtime, { downloads: 2, initializes: 0, uploads: 0, posts: 0 });
  });

  it("classifies a private Storage download failure before any LinkedIn call", async () => {
    const value = await fixture(1);
    const runtime = serviceFor(value);
    runtime.storage.download.mockRejectedValueOnce(new Error("private storage unavailable"));
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_failed"
    });
    expectCalls(runtime, { downloads: 1, initializes: 0, uploads: 0, posts: 0 });
  });

  it.each([
    ["initialize definite", "initializeImage", { outcome: "definite_failure" }, "media_upload_failed", 1, 0],
    ["initialize ambiguous", "initializeImage", { outcome: "unknown" }, "media_upload_unknown", 1, 0],
    ["upload definite", "uploadImage", { outcome: "definite_failure" }, "media_upload_failed", 1, 1],
    ["upload ambiguous", "uploadImage", { outcome: "unknown" }, "media_upload_unknown", 1, 1]
  ] as const)("maps %s without creating a post", async (_label, method, outcome, state, initializes, uploads) => {
    const value = await fixture(2);
    const runtime = serviceFor(value);
    runtime.client[method].mockResolvedValueOnce(outcome as never);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({ state });
    expectCalls(runtime, { downloads: 2, initializes, uploads, posts: 0 });
  });

  it("stops at a definite second-image failure with exact call counts", async () => {
    const value = await fixture(2);
    const runtime = serviceFor(value);
    runtime.client.initializeImage
      .mockResolvedValueOnce({
        outcome: "ready",
        imageUrn: "urn:li:image:first",
        uploadUrl: "https://upload.linkedin.com/first"
      })
      .mockResolvedValueOnce({ outcome: "definite_failure" } as never);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_failed"
    });
    expectCalls(runtime, { downloads: 2, initializes: 2, uploads: 1, posts: 0 });
  });

  it("matches attempt-media rows by position even when repository return order is reversed", async () => {
    const value = await fixture(2);
    const originalClaim = db.publishAttempts.claimExact;
    const controlled = {
      ...db,
      publishAttempts: {
        ...db.publishAttempts,
        claimExact: vi.fn(async (...args: Parameters<typeof originalClaim>) => {
          const result = await originalClaim(...args);
          return result.outcome === "recorded"
            ? { ...result, attemptMedia: [...result.attemptMedia].reverse() }
            : result;
        })
      }
    } as CareerDatabase;
    const runtime = serviceFor(value, {}, controlled);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toMatchObject({
      state: "published"
    });
    expectCalls(runtime, { downloads: 2, initializes: 2, uploads: 2, posts: 1 });
  });

  it.each(["after_initialize", "after_upload"] as const)(
    "durably records media_upload_unknown when persistence fails %s",
    async (point) => {
      const value = await fixture(1);
      const originalUpdate = db.publishAttemptMedia.updateState;
      let call = 0;
      const controlled = {
        ...db,
        publishAttemptMedia: {
          ...db.publishAttemptMedia,
          updateState: vi.fn(async (...args: Parameters<typeof originalUpdate>) => {
            call += 1;
            const failureCall = point === "after_initialize" ? 1 : 2;
            if (call === failureCall) throw new Error("database unavailable once");
            return originalUpdate(...args);
          })
        }
      } as CareerDatabase;
      const runtime = serviceFor(value, {}, controlled);
      await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
        state: "media_upload_unknown"
      });
      expect(runtime.client.createPost).not.toHaveBeenCalled();
      expect(await db.postDrafts.getVersion(value.post.draftId, value.post.version)).toMatchObject({
        state: "media_upload_unknown"
      });
    }
  );

  it.each([
    [{ outcome: "definite_failure" }, "publish_failed"],
    [{ outcome: "unknown" }, "publish_unknown"]
  ] as const)("maps final create result %# without retry", async (outcome, state) => {
    const value = await fixture(1);
    const runtime = serviceFor(value);
    runtime.client.createPost.mockResolvedValueOnce(outcome as never);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({ state });
    expectCalls(runtime, { downloads: 1, initializes: 1, uploads: 1, posts: 1 });
  });

  it.each(["initialize", "upload", "create"] as const)(
    "fails closed on a malformed %s client result",
    async (point) => {
      const value = await fixture(point === "create" ? 0 : 1);
      const runtime = serviceFor(value);
      if (point === "initialize") runtime.client.initializeImage.mockResolvedValueOnce(null as never);
      if (point === "upload") runtime.client.uploadImage.mockResolvedValueOnce(null as never);
      if (point === "create") runtime.client.createPost.mockResolvedValueOnce(null as never);
      await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
        state: point === "create" ? "publish_unknown" : "media_upload_unknown"
      });
      const attempts = await db.publishAttempts.listForPostDraft(value.post.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ phase: "complete" });
    }
  );

  it.each(["initialize", "upload", "create"] as const)(
    "treats a thrown %s result as terminal unknown without retry",
    async (point) => {
      const value = await fixture(point === "create" ? 0 : 1);
      const runtime = serviceFor(value);
      if (point === "initialize") runtime.client.initializeImage.mockRejectedValueOnce(new Error("timeout"));
      if (point === "upload") runtime.client.uploadImage.mockRejectedValueOnce(new Error("timeout"));
      if (point === "create") runtime.client.createPost.mockRejectedValueOnce(new Error("timeout"));
      await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
        state: point === "create" ? "publish_unknown" : "media_upload_unknown"
      });
      expect(runtime.client.initializeImage).toHaveBeenCalledTimes(point === "create" ? 0 : 1);
      expect(runtime.client.uploadImage).toHaveBeenCalledTimes(point === "upload" ? 1 : 0);
      expect(runtime.client.createPost).toHaveBeenCalledTimes(point === "create" ? 1 : 0);
    }
  );

  it("terminalizes a missing attempt-media mapping before any LinkedIn call", async () => {
    const value = await fixture(1);
    const originalClaim = db.publishAttempts.claimExact;
    const controlled = {
      ...db,
      publishAttempts: {
        ...db.publishAttempts,
        claimExact: vi.fn(async (...args: Parameters<typeof originalClaim>) => {
          const result = await originalClaim(...args);
          return result.outcome === "recorded" ? { ...result, attemptMedia: [] } : result;
        })
      }
    } as CareerDatabase;
    const runtime = serviceFor(value, {}, controlled);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_unknown"
    });
    expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
    expect((await db.publishAttempts.listForPostDraft(value.post.id))[0]).toMatchObject({
      phase: "complete",
      responseCategory: "media_ambiguous"
    });
  });

  it("terminalizes a failed pre-post phase transition when the database remains available", async () => {
    const value = await fixture(1);
    const controlled = {
      ...db,
      publishAttempts: {
        ...db.publishAttempts,
        transitionToCreatingPost: vi.fn(async () => false)
      }
    } as CareerDatabase;
    const runtime = serviceFor(value, {}, controlled);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "media_upload_unknown"
    });
    expectCalls(runtime, { downloads: 1, initializes: 1, uploads: 1, posts: 0 });
    expect((await db.publishAttempts.listForPostDraft(value.post.id))[0]).toMatchObject({
      phase: "complete",
      responseCategory: "media_ambiguous"
    });
  });

  it("returns publish_unknown when durable final completion cannot be recorded", async () => {
    const value = await fixture(0);
    const original = db.publishAttempts.complete;
    const controlled = {
      ...db,
      publishAttempts: {
        ...db.publishAttempts,
        complete: vi.fn(async () => { throw new Error("database unavailable"); })
      }
    } as CareerDatabase;
    const runtime = serviceFor(value, {}, controlled);
    await expect(runtime.service.publish(value.approvalCapability)).resolves.toEqual({
      state: "publish_unknown"
    });
    expect(runtime.client.createPost).toHaveBeenCalledTimes(1);
    expect(original).toBeTypeOf("function");
  });

  it("rejects corrupt five-media snapshots before any side effect", async () => {
    const value = await fixture(4);
    const fifth = await db.postMedia.create({
      id: randomUUID(), ownerSubject: subject, objectPath: `${subject}/ff/${randomUUID()}/fifth.png`,
      sha256: "f".repeat(64), mimeType: "image/png", byteSize: 1, width: 1, height: 1,
      frameCount: 1, originalFilename: null
    });
    await queryTestDatabase(db, "alter table career_mcp.post_draft_media drop constraint post_draft_media_position_check");
    try {
      await queryTestDatabase(db, `insert into career_mcp.post_draft_media(post_draft_id,version,position,media_id,alt_text) values ('${value.post.id}',${value.post.version},4,'${fifth.id}','Fifth')`);
      const runtime = serviceFor(value);
      await expect(runtime.service.publish(value.approvalCapability)).rejects.toBeTruthy();
      expectCalls(runtime, { downloads: 0, initializes: 0, uploads: 0, posts: 0 });
    } finally {
      await queryTestDatabase(db, `delete from career_mcp.post_draft_media where post_draft_id = '${value.post.id}' and position = 4`);
      await queryTestDatabase(db, "alter table career_mcp.post_draft_media add constraint post_draft_media_position_check check (position between 0 and 3)");
    }
  });
});
