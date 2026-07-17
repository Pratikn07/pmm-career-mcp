import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";
import { createDraftService } from "../../src/drafts/service.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  PREVIEW_TOKEN_HASH_CONTEXT,
  createPreviewService,
  type PreviewExpected,
  type PreviewResult
} from "../../src/posts/preview-service.js";

const db = (await createDatabase(":memory:"));
const drafts = createDraftService(db);
let nowMs = Date.parse("2026-07-16T12:00:00.000Z");
const clock = () => new Date(nowMs);
const previews = createPreviewService(db, { clock });

afterEach(async () => {
  (await db.resetForTests());
  nowMs = Date.parse("2026-07-16T12:00:00.000Z");
});
afterAll(async () => (await db.close()));

function expectedFor(preview: PreviewResult): PreviewExpected {
  return {
    postId: preview.postId,
    versionId: preview.versionId,
    version: preview.version,
    checksum: preview.checksum,
    visibility: preview.visibility
  };
}

async function expectDomainError(
  action: () => Promise<unknown>,
  code: string,
  token?: string
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    if (token !== undefined) {
      expect(error).not.toHaveProperty("cause");
      if (token.length > 0) {
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

describe("post previews", () => {
  it("returns the exact latest saved version and stores only a domain-separated token hash", async () => {
    const post = (await drafts.createPost({
      text: "Café\r\n🙂 exact  spacing",
      visibility: "PUBLIC"
    }));

    const preview = (await previews.create(post.id, post.version));

    expect(preview).toEqual({
      postId: post.id,
      versionId: post.versionId,
      text: post.text,
      version: post.version,
      checksum: post.checksum,
      visibility: post.visibility,
      characterCount: [...post.text].length,
      previewToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: "2026-07-16T12:15:00.000Z"
    });
    const expectedHash = createHash("sha256")
      .update(PREVIEW_TOKEN_HASH_CONTEXT, "utf8")
      .update("\0", "utf8")
      .update(Buffer.from(preview.previewToken, "base64url"))
      .digest("hex");
    const rows = (await db.previews.listForPostDraft(post.versionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      postDraftId: post.versionId,
      version: post.version,
      tokenHash: expectedHash,
      expiresAt: preview.expiresAt,
      consumedAt: null
    });
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(preview.previewToken);
  });

  it("generates unique high-entropy 32-byte base64url tokens by default", async () => {
    const post = (await drafts.createPost({ text: "Entropy", visibility: "CONNECTIONS" }));

    const tokens = await Promise.all(Array.from({ length: 64 }, async () => (
      (await previews.create(post.id, post.version)).previewToken
    )));

    expect(new Set(tokens).size).toBe(64);
    for (const token of tokens) {
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(Buffer.from(token, "base64url").toString("base64url")).toBe(token);
    }
  });

  it("uses the injected random-byte provider and rejects invalid provider output safely", async () => {
    const post = (await drafts.createPost({ text: "Injected entropy", visibility: "PUBLIC" }));
    const requestedSizes: number[] = [];
    const deterministic = createPreviewService(db, {
      clock,
      randomBytes: (size) => {
        requestedSizes.push(size);
        return Buffer.alloc(size, 0xa5);
      }
    });

    const preview = (await deterministic.create(post.id, post.version));

    expect(requestedSizes).toEqual([32]);
    expect(Buffer.from(preview.previewToken, "base64url")).toEqual(Buffer.alloc(32, 0xa5));

    const invalidProvider = createPreviewService(db, {
      clock,
      randomBytes: () => Buffer.alloc(31)
    });
    (await expectDomainError(
      async () => (await invalidProvider.create(post.id, post.version)),
      "DATA_INTEGRITY"
    ));
  });

  it("requires the requested version to exist and still be the current latest version", async () => {
    const first = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    const second = (await drafts.revisePost(first.id, "Second"));

    (await expectDomainError(async () => (await previews.create("missing-post", 1)), "NOT_FOUND"));
    (await expectDomainError(async () => (await previews.create(first.id, 999)), "NOT_FOUND"));
    (await expectDomainError(async () => (await previews.create(first.id, first.version)), "PREVIEW_STALE"));
    expect((await previews.create(second.id, second.version))).toMatchObject({
      postId: second.id,
      versionId: second.versionId,
      text: second.text,
      version: second.version
    });
  });

  it("consumes once atomically and rejects replay without exposing the token", async () => {
    const post = (await drafts.createPost({ text: "One use", visibility: "PUBLIC" }));
    const preview = (await previews.create(post.id, post.version));

    expect((await previews.consume(preview.previewToken, expectedFor(preview)))).toBeUndefined();
    expect((await db.previews.listForPostDraft(post.versionId))[0]?.consumedAt).toBe(
      "2026-07-16T12:00:00.000Z"
    );

    const replay = (await expectDomainError(
      async () => (await previews.consume(preview.previewToken, expectedFor(preview))),
      "PREVIEW_CONSUMED",
      preview.previewToken
    ));
    expect(replay.message).toBe("Preview token has already been used");
  });

  it("uses a 15-minute lifetime and treats the exact expiry instant as expired", async () => {
    const post = (await drafts.createPost({ text: "Boundary", visibility: "PUBLIC" }));
    const beforeBoundary = (await previews.create(post.id, post.version));
    const atBoundary = (await previews.create(post.id, post.version));

    nowMs += 15 * 60 * 1_000 - 1;
    expect((await previews.consume(beforeBoundary.previewToken, expectedFor(beforeBoundary)))).toBeUndefined();

    nowMs += 1;
    (await expectDomainError(
      async () => (await previews.consume(atBoundary.previewToken, expectedFor(atBoundary))),
      "PREVIEW_EXPIRED",
      atBoundary.previewToken
    ));
    expect((await db.previews.listForPostDraft(post.versionId))[1]?.consumedAt).toBeNull();
  });

  it("rejects malformed and empty tokens before persistence lookup", async () => {
    const post = (await drafts.createPost({ text: "Malformed", visibility: "PUBLIC" }));
    const preview = (await previews.create(post.id, post.version));
    const malformed = [
      "",
      "   ",
      "short",
      `${preview.previewToken}=`,
      preview.previewToken.slice(0, -1),
      `${preview.previewToken.slice(0, -1)}*`
    ];

    for (const token of malformed) {
      (await expectDomainError(
        async () => (await previews.consume(token, expectedFor(preview))),
        "PREVIEW_INVALID",
        token
      ));
    }
    expect((await db.previews.listForPostDraft(post.versionId))[0]?.consumedAt).toBeNull();
  });

  it("rejects cross-draft, version-row, version, checksum, and visibility substitution atomically", async () => {
    const firstPost = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    const secondPost = (await drafts.createPost({ text: "Second", visibility: "CONNECTIONS" }));
    const first = (await previews.create(firstPost.id, firstPost.version));
    const second = (await previews.create(secondPost.id, secondPost.version));
    const substitutions: PreviewExpected[] = [
      { ...expectedFor(first), postId: second.postId },
      { ...expectedFor(first), versionId: second.versionId },
      { ...expectedFor(first), version: first.version + 1 },
      { ...expectedFor(first), checksum: second.checksum },
      { ...expectedFor(first), visibility: "CONNECTIONS" }
    ];

    for (const expected of substitutions) {
      (await expectDomainError(
        async () => (await previews.consume(first.previewToken, expected)),
        "PREVIEW_MISMATCH",
        first.previewToken
      ));
      expect((await db.previews.listForPostDraft(first.versionId))[0]?.consumedAt).toBeNull();
    }

    expect((await previews.consume(first.previewToken, expectedFor(first)))).toBeUndefined();
  });

  it("rejects a revision made after preview without consuming the stale authorization", async () => {
    const first = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    const preview = (await previews.create(first.id, first.version));
    (await drafts.revisePost(first.id, "Revised after preview"));

    (await expectDomainError(
      async () => (await previews.consume(preview.previewToken, expectedFor(preview))),
      "PREVIEW_STALE",
      preview.previewToken
    ));
    expect((await db.previews.listForPostDraft(first.versionId))[0]?.consumedAt).toBeNull();
  });

  it("maps a competing repository consumption to a typed replay error", async () => {
    const post = (await drafts.createPost({ text: "Race", visibility: "PUBLIC" }));
    const preview = (await previews.create(post.id, post.version));
    const tokenHash = createHash("sha256")
      .update(PREVIEW_TOKEN_HASH_CONTEXT, "utf8")
      .update("\0", "utf8")
      .update(Buffer.from(preview.previewToken, "base64url"))
      .digest("hex");
    (await db.previews.consume(tokenHash, "2026-07-16T12:00:00.000Z"));

    (await expectDomainError(
      async () => (await previews.consume(preview.previewToken, expectedFor(preview))),
      "PREVIEW_CONSUMED",
      preview.previewToken
    ));
  });

  it("validates expected metadata and never includes user values in errors", async () => {
    const post = (await drafts.createPost({ text: "Metadata", visibility: "PUBLIC" }));
    const preview = (await previews.create(post.id, post.version));
    const privateId = "private-id-that-must-not-leak".repeat(20);
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...expectedFor(preview), unexpected: true },
      { ...expectedFor(preview), postId: "" },
      { ...expectedFor(preview), versionId: privateId },
      { ...expectedFor(preview), version: 0 },
      { ...expectedFor(preview), checksum: "not-a-checksum" },
      { ...expectedFor(preview), visibility: "PRIVATE" }
    ];

    for (const expected of invalidInputs) {
      const error = (await expectDomainError(
        async () => (await previews.consume(preview.previewToken, expected as PreviewExpected)),
        "VALIDATION_ERROR",
        preview.previewToken
      ));
      expect(JSON.stringify(error)).not.toContain(privateId);
    }
  });
});
