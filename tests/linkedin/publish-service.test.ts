import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/db/client.js";
import { createDraftService } from "../../src/drafts/service.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createPublishService,
  type PublishInput
} from "../../src/linkedin/publish-service.js";
import {
  createPreviewService,
  type PreviewResult
} from "../../src/posts/preview-service.js";

const db = createDatabase(":memory:");
const drafts = createDraftService(db);
let nowMs = Date.parse("2026-07-16T12:00:00.000Z");
const clock = () => new Date(nowMs);
const previews = createPreviewService(db, { clock });

afterEach(() => {
  db.resetForTests();
  nowMs = Date.parse("2026-07-16T12:00:00.000Z");
});
afterAll(() => db.close());

function inputFor(preview: PreviewResult): PublishInput {
  return {
    postId: preview.postId,
    versionId: preview.versionId,
    version: preview.version,
    checksum: preview.checksum,
    visibility: preview.visibility,
    previewToken: preview.previewToken
  };
}

function expectDomainError(action: () => unknown, code: string): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

describe("safe LinkedIn publishing", () => {
  it("checks the disabled kill switch before it consumes a preview or calls the client", async () => {
    const post = drafts.createPost({ text: "Do not send", visibility: "PUBLIC" });
    const preview = previews.create(post.id, post.version);
    const client = { createTextPost: vi.fn() };
    const service = createPublishService(db, {
      previewService: previews,
      client,
      publishEnabled: false,
      clock
    });

    await expect(service.publish(inputFor(preview))).rejects.toMatchObject({
      code: "PUBLISH_DISABLED"
    });

    expect(client.createTextPost).not.toHaveBeenCalled();
    expect(db.previews.listForPostDraft(post.versionId)[0]?.consumedAt).toBeNull();
    expect(db.publishAttempts.listForPostDraft(post.versionId)).toEqual([]);
  });

  it("rejects a malformed or missing preview token before recording an attempt", async () => {
    const post = drafts.createPost({ text: "Token required", visibility: "PUBLIC" });
    const preview = previews.create(post.id, post.version);
    const client = { createTextPost: vi.fn() };
    const service = createPublishService(db, {
      previewService: previews,
      client,
      publishEnabled: true,
      clock
    });

    await expect(service.publish({ ...inputFor(preview), previewToken: "" })).rejects.toMatchObject({
      code: "PREVIEW_INVALID"
    });

    expect(client.createTextPost).not.toHaveBeenCalled();
    expect(db.previews.listForPostDraft(post.versionId)[0]?.consumedAt).toBeNull();
    expect(db.publishAttempts.listForPostDraft(post.versionId)).toEqual([]);
  });

  it("records an attempt before one successful fake-client call and marks the exact version published", async () => {
    const post = drafts.createPost({ text: "Ship this exact text", visibility: "CONNECTIONS" });
    const preview = previews.create(post.id, post.version);
    const client = {
      createTextPost: vi.fn(async () => {
        const attempts = db.publishAttempts.listForPostDraft(post.versionId);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          responseCategory: "pending",
          requestedAt: "2026-07-16T12:00:00.000Z",
          completedAt: null
        });
        return { status: 201, postUrn: "urn:li:share:123" };
      })
    };
    const service = createPublishService(db, {
      previewService: previews,
      client,
      publishEnabled: true,
      clock
    });

    await expect(service.publish(inputFor(preview))).resolves.toEqual({
      state: "published",
      postUrn: "urn:li:share:123"
    });

    expect(client.createTextPost).toHaveBeenCalledTimes(1);
    expect(client.createTextPost).toHaveBeenCalledWith({
      text: preview.text,
      visibility: preview.visibility
    });
    expect(db.postDrafts.getVersion(post.id, post.version)).toMatchObject({ state: "published" });
    expect(db.publishAttempts.listForPostDraft(post.versionId)[0]).toMatchObject({
      responseCategory: "published",
      postUrn: "urn:li:share:123",
      completedAt: "2026-07-16T12:00:00.000Z"
    });
  });

  it("does not call the client for an expired or revised preview", async () => {
    const expiredPost = drafts.createPost({ text: "Expired", visibility: "PUBLIC" });
    const expired = previews.create(expiredPost.id, expiredPost.version);
    const revisedPost = drafts.createPost({ text: "First", visibility: "PUBLIC" });
    const stale = previews.create(revisedPost.id, revisedPost.version);
    drafts.revisePost(revisedPost.id, "Revised");
    const client = { createTextPost: vi.fn() };
    const service = createPublishService(db, {
      previewService: previews,
      client,
      publishEnabled: true,
      clock
    });

    await expect(service.publish(inputFor(stale))).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    nowMs += 15 * 60 * 1_000;
    await expect(service.publish(inputFor(expired))).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });

    expect(client.createTextPost).not.toHaveBeenCalled();
    expect(db.publishAttempts.listForPostDraft(expiredPost.versionId)).toEqual([]);
    expect(db.publishAttempts.listForPostDraft(revisedPost.versionId)).toEqual([]);
  });

  it("records a definite 4xx rejection as publish_failed without exposing response secrets", async () => {
    const post = drafts.createPost({ text: "Can fail", visibility: "PUBLIC" });
    const preview = previews.create(post.id, post.version);
    const privateToken = "very-private-access-token";
    const client = {
      createTextPost: vi.fn().mockResolvedValue({
        status: 400,
        authorization: `Bearer ${privateToken}`,
        error: { access_token: privateToken }
      })
    };
    const service = createPublishService(db, {
      previewService: previews,
      client,
      publishEnabled: true,
      clock
    });

    await expect(service.publish(inputFor(preview))).resolves.toEqual({ state: "publish_failed" });

    expect(client.createTextPost).toHaveBeenCalledTimes(1);
    expect(db.postDrafts.getVersion(post.id, post.version)).toMatchObject({ state: "publish_failed" });
    const attempt = db.publishAttempts.listForPostDraft(post.versionId)[0];
    expect(attempt).toMatchObject({ responseCategory: "definite_rejection" });
    expect(JSON.stringify(attempt)).not.toContain(privateToken);
  });

  it("treats timeout, 429, 5xx, and malformed success responses as unknown with no automatic retry", async () => {
    const cases = [
      new Error("timeout Authorization: Bearer private-token"),
      { status: 429 },
      { status: 503 },
      { status: 201, postUrn: "not-a-linkedin-urn" }
    ];

    for (const outcome of cases) {
      const post = drafts.createPost({ text: "Never duplicate", visibility: "PUBLIC" });
      const preview = previews.create(post.id, post.version);
      const client = {
        createTextPost: vi.fn().mockImplementation(async () => {
          if (outcome instanceof Error) {
            throw outcome;
          }
          return outcome;
        })
      };
      const service = createPublishService(db, {
        previewService: previews,
        client,
        publishEnabled: true,
        clock
      });

      await expect(service.publish(inputFor(preview))).resolves.toEqual({ state: "publish_unknown" });
      await expect(service.publish(inputFor(preview))).rejects.toMatchObject({
        code: "PREVIEW_CONSUMED"
      });

      expect(client.createTextPost).toHaveBeenCalledTimes(1);
      expect(db.postDrafts.getVersion(post.id, post.version)).toMatchObject({ state: "publish_unknown" });
      const attempt = db.publishAttempts.listForPostDraft(post.versionId)[0];
      expect(attempt).toMatchObject({ responseCategory: "ambiguous" });
      expect(JSON.stringify(attempt)).not.toContain("private-token");
    }
  });
});
