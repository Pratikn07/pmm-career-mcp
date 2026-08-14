import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerDatabase } from "../../src/db/client.js";
import { DomainError } from "../../src/domain/errors.js";
import type { OpenAiFileRef } from "../../src/media/file-download.js";
import type { ImageInspection } from "../../src/media/image-inspection.js";
import {
  createPostMediaService,
  type PostMediaServiceDependencies
} from "../../src/media/post-media-service.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import { createTestDatabase } from "../support/database.js";

const db = await createTestDatabase();
const subject = "123e4567-e89b-42d3-a456-426614174000";
const files: OpenAiFileRef[] = Array.from({ length: 4 }, (_, index) => ({
  download_url: `https://files.openai.example/${index + 1}`,
  file_id: `file-${index + 1}`,
  mime_type: index === 1 ? "image/jpeg" : "image/png",
  file_name: `image-${index + 1}.${index === 1 ? "jpg" : "png"}`
}));
const bytesById = new Map(files.map((file, index) => [
  file.file_id,
  Uint8Array.of(index + 1, index + 11, index + 21)
]));

function inspectionFor(file: OpenAiFileRef, bytes: Uint8Array): ImageInspection {
  const index = files.findIndex(({ file_id }) => file_id === file.file_id);
  return {
    mimeType: file.mime_type === "image/jpeg" ? "image/jpeg" : "image/png",
    width: 100 + index,
    height: 80 + index,
    frameCount: 1,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

const downloadFile = vi.fn<(file: OpenAiFileRef) => Promise<Uint8Array>>(async (file) => {
  const bytes = bytesById.get(file.file_id);
  if (bytes === undefined) throw new Error("unknown fixture");
  return new Uint8Array(bytes);
});
const inspectImage = vi.fn<(
  bytes: Uint8Array,
  declaredMime?: string
) => Promise<ImageInspection>>(async (bytes, declaredMime) => {
  const file = files.find((candidate) => (
    bytes[0] === bytesById.get(candidate.file_id)?.[0]
  ));
  if (file === undefined || (declaredMime !== undefined && declaredMime !== file.mime_type)) {
    throw new DomainError("MEDIA_VALIDATION_ERROR", "Draft image validation failed");
  }
  return inspectionFor(file, bytes);
});
const upload = vi.fn<(
  path: string,
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png" | "image/gif"
) => Promise<void>>(async () => undefined);
const remove = vi.fn<(paths: readonly string[]) => Promise<void>>(async () => undefined);
const storage = {
  upload,
  download: vi.fn(),
  createSignedUrl: vi.fn(),
  remove
};

function service(database: CareerDatabase = db) {
  const dependencies: PostMediaServiceDependencies = {
    subject,
    storage,
    downloadFile,
    inspectImage
  };
  return createPostMediaService(database, dependencies);
}

async function textDraft(text = "Private PMM draft", ownerSubject = subject) {
  return await db.postDrafts.createVersion({
    ownerSubject,
    text,
    visibility: "CONNECTIONS",
    checksum: "legacy-v1",
    state: "draft"
  });
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

beforeEach(() => {
  downloadFile.mockClear();
  inspectImage.mockClear();
  upload.mockClear();
  remove.mockClear();
  storage.createSignedUrl.mockReset();
  storage.createSignedUrl.mockImplementation(async (path: string) => (
    `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(path)}`
  ));
});
afterEach(async () => db.resetForTests());
afterAll(async () => db.close());

describe("post media service", () => {
  it("reloads and signs one exact owned immutable path per image in display order for 900 seconds", async () => {
    const first = await textDraft();
    const attached = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: files.slice(0, 3),
      altTexts: ["One", "Two", "Three"]
    });
    const rows = await db.postDraftMedia.listForVersion(attached.versionId, attached.version);

    await expect(service().createSignedUrls(attached)).resolves.toEqual(rows.map(({ objectPath }) => (
      `https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(objectPath)}`
    )));
    expect(storage.createSignedUrl).toHaveBeenCalledTimes(3);
    expect(storage.createSignedUrl.mock.calls).toEqual(rows.map(({ objectPath }) => [objectPath, 900]));
  });

  it.each([
    ["caller metadata", (row: Awaited<ReturnType<typeof db.postDraftMedia.listForVersion>>[number]) => ({
      publicAltText: `${row.altText} changed`
    })],
    ["dense order", (row: Awaited<ReturnType<typeof db.postDraftMedia.listForVersion>>[number]) => ({
      storedPosition: row.position + 1
    })],
    ["owner", () => ({ storedOwner: randomUUID() })],
    ["subject path", () => ({ storedPath: `${randomUUID()}/aa/${randomUUID()}.png` })]
  ])("fails closed before signing when %s does not match the immutable owner-scoped version", async (_label, mutate) => {
    const first = await textDraft();
    const attached = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Exact alt text"]
    });
    const row = (await db.postDraftMedia.listForVersion(attached.versionId, attached.version))[0]!;
    const mutation = mutate(row);
    const corruptDatabase = {
      ...db,
      postDraftMedia: {
        ...db.postDraftMedia,
        listForVersion: vi.fn(async () => [{
          ...row,
          position: "storedPosition" in mutation ? mutation.storedPosition : row.position,
          ownerSubject: "storedOwner" in mutation ? mutation.storedOwner : row.ownerSubject,
          objectPath: "storedPath" in mutation ? mutation.storedPath : row.objectPath
        }])
      }
    } as CareerDatabase;
    const requested = "publicAltText" in mutation
      ? { ...attached, media: [{ ...attached.media[0]!, altText: mutation.publicAltText }] }
      : attached;

    await expectCode(() => service(corruptDatabase).createSignedUrls(requested), "DATA_INTEGRITY");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4])("attaches %i unchanged files in order as one immutable version", async (count) => {
    const first = await textDraft();
    const originals = files.slice(0, count).map((file) => new Uint8Array(bytesById.get(file.file_id)!));
    const next = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: files.slice(0, count),
      altTexts: Array.from({ length: count }, (_, index) => ` Image ${index + 1} `)
    });

    expect(next.version).toBe(2);
    expect(next.media.map(({ position, altText }) => ({ position, altText }))).toEqual(
      Array.from({ length: count }, (_, position) => ({ position, altText: `Image ${position + 1}` }))
    );
    expect(next.checksum).toBe(checksumLinkedInPost({
      draftId: next.id,
      version: next.version,
      text: next.text,
      visibility: next.visibility,
      media: next.media
    }));
    expect(await db.postDraftMedia.listForVersion(first.id, 1)).toEqual([]);
    expect(downloadFile).toHaveBeenCalledTimes(count);
    expect(upload).toHaveBeenCalledTimes(count);
    for (let index = 0; index < count; index += 1) {
      expect(bytesById.get(files[index]!.file_id)).toEqual(originals[index]);
      const shard = inspectionFor(files[index]!, originals[index]!).sha256.slice(0, 2);
      expect(upload.mock.calls[index]?.[0]).toMatch(
        new RegExp(`^${subject}/${shard}/[0-9a-f-]{36}\\.(png|jpg)$`)
      );
      expect(Buffer.from(upload.mock.calls[index]?.[1] ?? []).equals(originals[index]!)).toBe(true);
    }
  });

  it("deduplicates only within the owner and does not upload an owned SHA twice", async () => {
    const first = await textDraft();
    const attached = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["First"]
    });
    upload.mockClear();
    const replaced = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: attached.version,
      images: [files[0]!],
      altTexts: ["Same bytes"]
    });
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replaced.media[0]?.mediaId).toBe(attached.media[0]?.mediaId);

    const otherSubject = randomUUID();
    const other = createPostMediaService(db, {
      subject: otherSubject,
      storage,
      downloadFile,
      inspectImage
    });
    const otherDraft = await textDraft("Other owner", otherSubject);
    await other.attachFiles({
      postId: otherDraft.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Other owner"]
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatch(new RegExp(`^${otherSubject}/`));
  });

  it("replaces, removes, reorders, and revises alt text without mutating prior rows", async () => {
    const first = await textDraft();
    const attached = await service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: files.slice(0, 3),
      altTexts: ["One", "Two", "Three"]
    });
    const originalRows = await db.postDraftMedia.listForVersion(attached.versionId, attached.version);
    const changed = await service().setMedia({
      postId: first.draftId,
      expectedVersion: attached.version,
      media: [
        { mediaId: attached.media[2]!.mediaId, altText: " Three revised " },
        { mediaId: attached.media[0]!.mediaId, altText: "One" }
      ]
    });
    const removed = await service().setMedia({
      postId: first.draftId,
      expectedVersion: changed.version,
      media: []
    });

    expect(changed.media.map(({ mediaId, position, altText }) => ({ mediaId, position, altText }))).toEqual([
      { mediaId: attached.media[2]!.mediaId, position: 0, altText: "Three revised" },
      { mediaId: attached.media[0]!.mediaId, position: 1, altText: "One" }
    ]);
    expect(removed.media).toEqual([]);
    expect(await db.postDraftMedia.listForVersion(attached.versionId, attached.version)).toEqual(originalRows);
    expect((await service().getVersion(first.draftId, changed.version))?.media).toEqual(changed.media);
  });

  it("rejects stale versions before downloading and media owned by another subject", async () => {
    const first = await textDraft();
    await expectCode(() => service().attachFiles({
      postId: first.draftId,
      expectedVersion: 2,
      images: [files[0]!],
      altTexts: ["Stale"]
    }), "CONFLICT");
    expect(downloadFile).not.toHaveBeenCalled();

    const otherOwner = randomUUID();
    const foreign = await db.postMedia.create({
      id: randomUUID(),
      ownerSubject: otherOwner,
      objectPath: `${otherOwner}/aa/${randomUUID()}.png`,
      sha256: "f".repeat(64),
      mimeType: "image/png",
      byteSize: 3,
      width: 1,
      height: 1,
      frameCount: 1
    });
    await expectCode(() => service().setMedia({
      postId: first.draftId,
      expectedVersion: 1,
      media: [{ mediaId: foreign.id, altText: "Forbidden" }]
    }), "NOT_FOUND");
    expect((await db.postDrafts.listVersions(first.draftId))).toHaveLength(1);
  });

  it("rechecks the expected version inside the write transaction after file ingestion", async () => {
    const first = await textDraft();
    const racingDownload = vi.fn(async (file: OpenAiFileRef) => {
      await db.postDrafts.createVersion({
        draftId: first.draftId,
        ownerSubject: subject,
        text: "Concurrent text revision",
        visibility: first.visibility,
        checksum: "concurrent-version",
        state: "draft"
      });
      return new Uint8Array(bytesById.get(file.file_id)!);
    });
    const racingService = createPostMediaService(db, {
      subject,
      storage,
      downloadFile: racingDownload,
      inspectImage
    });

    await expectCode(() => racingService.attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Race-safe image"]
    }), "CONFLICT");

    expect((await db.postDrafts.listVersions(first.draftId)).map(({ version }) => version)).toEqual([1, 2]);
    expect(await db.postMedia.getByOwnerAndSha(
      subject,
      inspectionFor(files[0]!, bytesById.get(files[0]!.file_id)!).sha256
    )).toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid alt text, validation failures, and storage failures without new versions", async () => {
    const first = await textDraft();
    for (const altText of [
      "",
      "line one\nline two",
      "line one\u2028line two",
      "line one\u2029line two",
      "x".repeat(121)
    ]) {
      await expectCode(() => service().attachFiles({
        postId: first.draftId,
        expectedVersion: 1,
        images: [files[0]!],
        altTexts: [altText]
      }), "VALIDATION_ERROR");
    }
    expect(downloadFile).not.toHaveBeenCalled();

    inspectImage.mockRejectedValueOnce(
      new DomainError("MEDIA_VALIDATION_ERROR", "Draft image validation failed")
    );
    await expectCode(() => service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Image"]
    }), "MEDIA_VALIDATION_ERROR");

    upload.mockRejectedValueOnce(new DomainError("MEDIA_STORAGE_ERROR", "Draft media storage operation failed"));
    await expectCode(() => service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[1]!],
      altTexts: ["Image"]
    }), "MEDIA_STORAGE_ERROR");
    expect((await db.postDrafts.listVersions(first.draftId))).toHaveLength(1);
  });

  it("best-effort removes a provisional path when Storage may have committed before throwing", async () => {
    const first = await textDraft();
    upload.mockRejectedValueOnce(
      new DomainError("MEDIA_STORAGE_ERROR", "Draft media storage operation failed")
    );

    await expectCode(() => service().attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Ambiguous upload"]
    }), "MEDIA_STORAGE_ERROR");

    expect(remove).toHaveBeenCalledTimes(1);
    const shard = inspectionFor(files[0]!, bytesById.get(files[0]!.file_id)!)
      .sha256.slice(0, 2);
    expect(remove.mock.calls[0]?.[0]).toEqual([
      expect.stringMatching(new RegExp(`^${subject}/${shard}/[0-9a-f-]{36}\\.png$`))
    ]);
    expect(await db.postMedia.getByOwnerAndSha(
      subject,
      inspectionFor(files[0]!, bytesById.get(files[0]!.file_id)!).sha256
    )).toBeUndefined();
  });

  it("removes newly uploaded objects best-effort when the database version write fails", async () => {
    const first = await textDraft();
    const createVersionWithMedia = vi.fn(async () => {
      throw new Error("private database failure body");
    });
    const failingDatabase = {
      ...db,
      postDrafts: { ...db.postDrafts, createVersionWithMedia }
    } as CareerDatabase;
    remove.mockRejectedValueOnce(new Error("private cleanup failure body"));

    const error = await expectCode(() => service(failingDatabase).attachFiles({
      postId: first.draftId,
      expectedVersion: 1,
      images: [files[0]!],
      altTexts: ["Image"]
    }), "DATA_INTEGRITY");
    expect(error.message).not.toMatch(/private|cleanup|database/i);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toHaveLength(1);
    expect((await db.postDrafts.listVersions(first.draftId))).toHaveLength(1);
    expect(await db.postMedia.getByOwnerAndSha(
      subject,
      inspectionFor(files[0]!, bytesById.get(files[0]!.file_id)!).sha256
    )).toBeUndefined();
  });
});
