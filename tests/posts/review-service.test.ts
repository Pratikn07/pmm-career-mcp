import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDraftService } from "../../src/drafts/service.js";
import { DomainError } from "../../src/domain/errors.js";
import type { DraftMediaStorage } from "../../src/media/storage.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import {
  APPROVAL_CAPABILITY_HASH_CONTEXT,
  createReviewService
} from "../../src/posts/review-service.js";
import { hashApprovalCapability } from "../../src/posts/preview-service.js";
import { createTestDatabase, queryTestDatabase } from "../support/database.js";

const db = await createTestDatabase();
const drafts = createDraftService(db);

const SUBJECT = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_SUBJECT = "123e4567-e89b-12d3-a456-426614174099";
const DRAFT_ID = "223e4567-e89b-12d3-a456-426614174000";
const MEDIA_IDS = [
  "323e4567-e89b-12d3-a456-426614174000",
  "323e4567-e89b-12d3-a456-426614174001",
  "323e4567-e89b-12d3-a456-426614174002",
  "323e4567-e89b-12d3-a456-426614174003"
] as const;
const NOW = "2026-07-19T12:00:00.000Z";
const ACCESS_TOKEN = "private-request-bearer-that-must-never-leak";

type CreatedV2Draft = Awaited<ReturnType<typeof createV2Draft>>;

function storage(overrides: Partial<DraftMediaStorage> = {}): DraftMediaStorage {
  return {
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => new Uint8Array([1])),
    createSignedUrl: vi.fn(async (path) => (
      `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(path)}`
    )),
    remove: vi.fn(async () => undefined),
    ...overrides
  };
}

async function createV2Draft(input: {
  subject?: string;
  draftId?: string;
  mediaCount?: number;
  text?: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
  state?: string;
} = {}) {
  const ownerSubject = input.subject ?? SUBJECT;
  const draftId = input.draftId ?? DRAFT_ID;
  const mediaCount = input.mediaCount ?? 0;
  const text = input.text ?? "Exact PMM launch notes";
  const visibility = input.visibility ?? "CONNECTIONS";
  const media = [];
  for (let position = 0; position < mediaCount; position += 1) {
    const id = MEDIA_IDS[position]!;
    const sha256 = String(position + 1).repeat(64);
    await db.postMedia.create({
      id,
      ownerSubject,
      objectPath: `${ownerSubject}/${sha256.slice(0, 2)}/${id}.png`,
      sha256,
      mimeType: "image/png",
      byteSize: 100 + position,
      width: 640 + position,
      height: 480 + position,
      frameCount: 1,
      originalFilename: `image-${position + 1}.png`,
      createdAt: NOW
    });
    media.push({ mediaId: id, altText: `Image ${position + 1}` });
  }
  const created = await db.postDrafts.createVersionWithMedia({
    draftId,
    ...(mediaCount === 0 ? {} : { ownerSubject }),
    text,
    visibility,
    state: input.state ?? "draft",
    media,
    checksum: (version, actualDraftId, checksumMedia) => checksumLinkedInPost({
      draftId: actualDraftId,
      version,
      text,
      visibility,
      media: checksumMedia.map((item) => ({
        ...item,
        mimeType: item.mimeType as "image/png"
      }))
    })
  });
  return { draftId, ownerSubject, ...created };
}

function review(
  mediaStorage: DraftMediaStorage,
  overrides: {
    subject?: string;
    randomBytes?: (size: number) => Uint8Array;
    clock?: () => Date;
  } = {}
) {
  return createReviewService(db, {
    subject: overrides.subject ?? SUBJECT,
    storage: mediaStorage,
    clock: overrides.clock ?? (() => new Date(NOW)),
    ...(overrides.randomBytes === undefined ? {} : { randomBytes: overrides.randomBytes })
  });
}

async function expectDomainError(
  action: () => Promise<unknown>,
  code: string
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

afterEach(async () => {
  await db.resetForTests();
  vi.restoreAllMocks();
});

afterAll(async () => db.close());

describe("exact LinkedIn review creation", () => {
  it("locks an exact latest v2 text draft for 15 minutes and stores only a context-separated hash", async () => {
    const created = await createV2Draft();
    const requestedSizes: number[] = [];
    const entropy = Buffer.alloc(32, 0xa5);

    const result = await review(storage(), {
      randomBytes: (size) => {
        requestedSizes.push(size);
        return entropy;
      }
    }).createExact(created.draftId, created.post.version);

    expect(requestedSizes).toEqual([32]);
    expect(result.approvalCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.approvalCapability, "base64url")).toEqual(entropy);
    expect(result.preview).toEqual({
      postId: created.draftId,
      versionId: created.post.id,
      text: created.post.text,
      version: created.post.version,
      checksum: created.post.checksum,
      visibility: created.post.visibility,
      characterCount: [...created.post.text].length,
      media: [],
      expiresAt: "2026-07-19T12:15:00.000Z"
    });
    expect(result.signedMediaUrls).toEqual([]);

    const previews = await db.previews.listForPostDraft(created.post.id);
    const expectedHash = createHash("sha256")
      .update(APPROVAL_CAPABILITY_HASH_CONTEXT, "utf8")
      .update("\0", "utf8")
      .update(entropy)
      .digest("hex");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      postDraftId: created.post.id,
      version: created.post.version,
      tokenHash: expectedHash,
      expiresAt: result.preview.expiresAt,
      consumedAt: null
    });
    expect(JSON.stringify(previews)).not.toContain(result.approvalCapability);
    expect(await db.postDrafts.getVersion(created.draftId, created.post.version)).toMatchObject({
      state: "previewed"
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it("returns zero-to-four ordered media and signs every private object for no more than 900 seconds", async () => {
    for (const mediaCount of [1, 2, 3, 4]) {
      await db.resetForTests();
      const created = await createV2Draft({ mediaCount });
      const createSignedUrl = vi.fn(async (path: string, expiresInSeconds: number) => (
        `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(path)}`
      ));

      const result = await review(storage({ createSignedUrl })).createExact(
        created.draftId,
        created.post.version
      );

      expect(createSignedUrl).toHaveBeenCalledTimes(mediaCount);
      expect(createSignedUrl.mock.calls.map(([, seconds]) => seconds)).toEqual(
        Array(mediaCount).fill(900)
      );
      expect(result.preview.media.map(({ position, altText }) => ({ position, altText }))).toEqual(
        Array.from({ length: mediaCount }, (_, position) => ({
          position,
          altText: `Image ${position + 1}`
        }))
      );
      expect(result.preview.media.every((item) => !("objectPath" in item))).toBe(true);
      expect(result.signedMediaUrls.map(({ position }) => position)).toEqual(
        Array.from({ length: mediaCount }, (_, position) => position)
      );
    }
  });

  it("rejects legacy-v1, corrupt-v2, stale, and invalid-state drafts without creating a preview", async () => {
    const legacy = await drafts.createPost({ text: "Legacy text", visibility: "PUBLIC" });
    await expectDomainError(
      () => review(storage()).createExact(legacy.id, legacy.version),
      "DATA_INTEGRITY"
    );

    await db.resetForTests();
    const corrupt = await createV2Draft();
    await queryTestDatabase(db, `
      update career_mcp.post_drafts
      set checksum = '${"f".repeat(64)}'
      where id = '${corrupt.post.id}'
    `);
    await expectDomainError(
      () => review(storage()).createExact(corrupt.draftId, corrupt.post.version),
      "DATA_INTEGRITY"
    );

    await db.resetForTests();
    const stale = await createV2Draft();
    await db.postDrafts.createVersionWithMedia({
      draftId: stale.draftId,
      expectedVersion: stale.post.version,
      text: "Newer exact version",
      visibility: "CONNECTIONS",
      state: "draft",
      media: [],
      checksum: (version, draftId) => checksumLinkedInPost({
        draftId,
        version,
        text: "Newer exact version",
        visibility: "CONNECTIONS",
        media: []
      })
    });
    await expectDomainError(
      () => review(storage()).createExact(stale.draftId, stale.post.version),
      "PREVIEW_STALE"
    );

    await db.resetForTests();
    const publishing = await createV2Draft({ state: "publishing" });
    await expectDomainError(
      () => review(storage()).createExact(publishing.draftId, publishing.post.version),
      "INVALID_TRANSITION"
    );

    expect(await db.previews.listForPostDraft(publishing.post.id)).toEqual([]);
  });

  it("rejects media owned by another subject without signing or revealing the draft", async () => {
    const created = await createV2Draft({ subject: OTHER_SUBJECT, mediaCount: 1 });
    const createSignedUrl = vi.fn();

    await expectDomainError(
      () => review(storage({ createSignedUrl })).createExact(created.draftId, created.post.version),
      "NOT_FOUND"
    );

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(await db.previews.listForPostDraft(created.post.id)).toEqual([]);
  });

  it("rejects a corrupt five-image version before signing or persistence", async () => {
    const created = await createV2Draft({ mediaCount: 4 });
    const fifthId = "323e4567-e89b-12d3-a456-426614174004";
    await db.postMedia.create({
      id: fifthId,
      ownerSubject: SUBJECT,
      objectPath: `${SUBJECT}/55/${fifthId}.png`,
      sha256: "5".repeat(64),
      mimeType: "image/png",
      byteSize: 105,
      width: 645,
      height: 485,
      frameCount: 1,
      originalFilename: "image-5.png",
      createdAt: NOW
    });
    await queryTestDatabase(db, `
      alter table career_mcp.post_draft_media
      drop constraint post_draft_media_position_check
    `);
    await queryTestDatabase(db, `
      insert into career_mcp.post_draft_media
        (post_draft_id, version, position, media_id, alt_text)
      values ('${created.post.id}', ${created.post.version}, 4, '${fifthId}', 'Image 5')
    `);
    const createSignedUrl = vi.fn();

    try {
      await expectDomainError(
        () => review(storage({ createSignedUrl })).createExact(created.draftId, created.post.version),
        "DATA_INTEGRITY"
      );
      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(await db.previews.listForPostDraft(created.post.id)).toEqual([]);
    } finally {
      await queryTestDatabase(db, `
        delete from career_mcp.post_draft_media where position = 4
      `);
      await queryTestDatabase(db, `
        alter table career_mcp.post_draft_media
        add constraint post_draft_media_position_check check (position between 0 and 3)
      `);
    }
  });

  it("persists nothing when any signed URL fails and rejects a revision made while URLs are prepared", async () => {
    const signingFailure = await createV2Draft({ mediaCount: 2 });
    const createSignedUrl = vi.fn(async (_path: string, _seconds: number) => {
      if (createSignedUrl.mock.calls.length === 2) {
        throw new DomainError("MEDIA_STORAGE_ERROR", "private-provider-detail");
      }
      return "https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/first";
    });

    const signingError = await expectDomainError(
      () => review(storage({ createSignedUrl })).createExact(
        signingFailure.draftId,
        signingFailure.post.version
      ),
      "MEDIA_STORAGE_ERROR"
    );
    expect(JSON.stringify(signingError)).not.toContain("private-provider-detail");
    expect(await db.previews.listForPostDraft(signingFailure.post.id)).toEqual([]);
    expect(await db.postDrafts.getVersion(
      signingFailure.draftId,
      signingFailure.post.version
    )).toMatchObject({ state: "draft" });

    await db.resetForTests();
    const raced = await createV2Draft({ mediaCount: 1 });
    const raceStorage = storage({
      createSignedUrl: vi.fn(async () => {
        await db.postDrafts.createVersionWithMedia({
          draftId: raced.draftId,
          expectedVersion: raced.post.version,
          text: "A concurrent revision",
          visibility: "CONNECTIONS",
          state: "draft",
          media: [],
          checksum: (version, draftId) => checksumLinkedInPost({
            draftId,
            version,
            text: "A concurrent revision",
            visibility: "CONNECTIONS",
            media: []
          })
        });
        return "https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/race";
      })
    });
    await expectDomainError(
      () => review(raceStorage).createExact(raced.draftId, raced.post.version),
      "PREVIEW_STALE"
    );
    expect(await db.previews.listForPostDraft(raced.post.id)).toEqual([]);
  });

  it("rejects an in-place media and join mutation made while signed URLs are prepared", async () => {
    const created = await createV2Draft({ mediaCount: 1 });
    const signedPath = `${SUBJECT}/11/${MEDIA_IDS[0]}.png`;
    const mutatedPath = `${SUBJECT}/11/${MEDIA_IDS[0]}-mutated.png`;
    const raceStorage = storage({
      createSignedUrl: vi.fn(async (path, seconds) => {
        expect(path).toBe(signedPath);
        expect(seconds).toBe(900);
        await queryTestDatabase(db, `
          update career_mcp.post_draft_media
          set alt_text = 'Mutated after signing'
          where post_draft_id = '${created.post.id}' and version = ${created.post.version}
        `);
        await queryTestDatabase(db, `
          update career_mcp.post_media
          set object_path = '${mutatedPath}', width = 641
          where id = '${MEDIA_IDS[0]}'
        `);
        return "https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/original";
      })
    });

    await expectDomainError(
      () => review(raceStorage).createExact(created.draftId, created.post.version),
      "DATA_INTEGRITY"
    );

    expect(await db.previews.listForPostDraft(created.post.id)).toEqual([]);
    expect(await db.postDrafts.getVersion(created.draftId, created.post.version)).toMatchObject({
      state: "draft"
    });
  });

  it("serializes concurrent same-version previews so only the matching latest capability remains active", async () => {
    const created = await createV2Draft({ mediaCount: 1, state: "ready_for_review" });
    let signingCalls = 0;
    let releaseSigning!: () => void;
    const signingGate = new Promise<void>((resolve) => {
      releaseSigning = resolve;
    });
    const concurrentStorage = storage({
      createSignedUrl: vi.fn(async () => {
        signingCalls += 1;
        if (signingCalls === 2) releaseSigning();
        await signingGate;
        return `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${signingCalls}`;
      })
    });
    const service = review(concurrentStorage);

    const [first, second] = await Promise.all([
      service.createExact(created.draftId, created.post.version),
      service.createExact(created.draftId, created.post.version)
    ]);

    expect(second.approvalCapability).not.toBe(first.approvalCapability);
    const rows = await db.previews.listForPostDraft(created.post.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ consumedAt }) => consumedAt === null)).toHaveLength(1);
    expect(rows.filter(({ consumedAt }) => consumedAt === NOW)).toHaveLength(1);
    const capabilityRows = await Promise.all([first, second].map(async ({ approvalCapability }) => (
      db.previews.getByTokenHash(hashApprovalCapability(approvalCapability))
    )));
    expect(capabilityRows.filter((row) => row?.consumedAt === null)).toHaveLength(1);
    expect(capabilityRows.filter((row) => row?.consumedAt === NOW)).toHaveLength(1);
    expect(await db.postDrafts.getVersion(created.draftId, created.post.version)).toMatchObject({
      state: "previewed"
    });
  });

  it("previews two drafts that reference the same media in reverse display order", async () => {
    for (let position = 0; position < 2; position += 1) {
      const id = MEDIA_IDS[position]!;
      const sha256 = String(position + 1).repeat(64);
      await db.postMedia.create({
        id,
        ownerSubject: SUBJECT,
        objectPath: `${SUBJECT}/${sha256.slice(0, 2)}/${id}.png`,
        sha256,
        mimeType: "image/png",
        byteSize: 100 + position,
        width: 640 + position,
        height: 480 + position,
        frameCount: 1,
        originalFilename: `shared-${position + 1}.png`,
        createdAt: NOW
      });
    }
    const createSharedDraft = async (
      draftId: string,
      text: string,
      orderedMediaIds: readonly [string, string]
    ) => db.postDrafts.createVersionWithMedia({
      draftId,
      ownerSubject: SUBJECT,
      text,
      visibility: "CONNECTIONS",
      state: "ready_for_review",
      media: orderedMediaIds.map((mediaId, position) => ({
        mediaId,
        altText: `${text} image ${position + 1}`
      })),
      checksum: (version, actualDraftId, checksumMedia) => checksumLinkedInPost({
        draftId: actualDraftId,
        version,
        text,
        visibility: "CONNECTIONS",
        media: checksumMedia.map((item) => ({
          ...item,
          mimeType: item.mimeType as "image/png"
        }))
      })
    });
    const first = await createSharedDraft(
      DRAFT_ID,
      "First shared-media draft",
      [MEDIA_IDS[0], MEDIA_IDS[1]]
    );
    const secondDraftId = "223e4567-e89b-12d3-a456-426614174001";
    const second = await createSharedDraft(
      secondDraftId,
      "Second shared-media draft",
      [MEDIA_IDS[1], MEDIA_IDS[0]]
    );

    let signingCalls = 0;
    let releaseSigning!: () => void;
    const signingGate = new Promise<void>((resolve) => {
      releaseSigning = resolve;
    });
    const concurrentStorage = storage({
      createSignedUrl: vi.fn(async (path) => {
        signingCalls += 1;
        if (signingCalls === 4) releaseSigning();
        await signingGate;
        return `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(path)}`;
      })
    });
    const service = review(concurrentStorage);

    const [firstPreview, secondPreview] = await Promise.all([
      service.createExact(DRAFT_ID, first.post.version),
      service.createExact(secondDraftId, second.post.version)
    ]);

    expect(firstPreview.preview.media.map(({ mediaId }) => mediaId)).toEqual([
      MEDIA_IDS[0],
      MEDIA_IDS[1]
    ]);
    expect(secondPreview.preview.media.map(({ mediaId }) => mediaId)).toEqual([
      MEDIA_IDS[1],
      MEDIA_IDS[0]
    ]);
    for (const post of [first.post, second.post]) {
      const rows = await db.previews.listForPostDraft(post.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.consumedAt).toBeNull();
      expect(await db.postDrafts.getVersion(post.draftId, post.version)).toMatchObject({
        state: "previewed"
      });
    }
  });

  it("rejects invalid clocks and random sources without signing, persisting, or leaking source data", async () => {
    const created = await createV2Draft({ mediaCount: 1 });
    for (const randomBytes of [
      () => Buffer.alloc(31),
      () => { throw new Error(`${ACCESS_TOKEN}-random-source`); }
    ]) {
      const createSignedUrl = vi.fn();
      await expectDomainError(
        () => review(storage({ createSignedUrl }), { randomBytes }).createExact(
          created.draftId,
          created.post.version
        ),
        "DATA_INTEGRITY"
      );
      expect(createSignedUrl).not.toHaveBeenCalled();
    }
    await expectDomainError(
      () => review(storage(), { clock: () => new Date("invalid") }).createExact(
        created.draftId,
        created.post.version
      ),
      "DATA_INTEGRITY"
    );
    expect(await db.previews.listForPostDraft(created.post.id)).toEqual([]);
  });
});
