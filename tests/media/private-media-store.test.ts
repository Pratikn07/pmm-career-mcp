import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerDatabase } from "../../src/db/client.js";
import { DomainError } from "../../src/domain/errors.js";
import type { OpenAiFileRef } from "../../src/media/file-download.js";
import type { ImageInspection } from "../../src/media/image-inspection.js";
import {
  createPrivateMediaStore,
  type StoredPrivateMedia
} from "../../src/media/private-media-store.js";
import { createTestDatabase } from "../support/database.js";

const db = await createTestDatabase();
const owner = "123e4567-e89b-42d3-a456-426614174000";
const otherOwner = "223e4567-e89b-42d3-a456-426614174000";
const mediaId = "323e4567-e89b-42d3-a456-426614174000";
const otherMediaId = "423e4567-e89b-42d3-a456-426614174000";
const fixturePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = "ab".repeat(32);
const pngInspection: ImageInspection = {
  mimeType: "image/png",
  width: 1200,
  height: 627,
  frameCount: 1,
  byteSize: fixturePng.byteLength,
  sha256
};
const openAiFile: OpenAiFileRef = {
  download_url: "https://files.openai.example/private-image",
  file_id: "file-private-image",
  mime_type: "image/png",
  file_name: "campaign-image.png"
};

const upload = vi.fn(async (
  _path: string,
  _bytes: Uint8Array,
  _mimeType: "image/jpeg" | "image/png" | "image/gif"
) => undefined);
const remove = vi.fn(async (_paths: readonly string[]) => undefined);
const storage = {
  upload,
  download: vi.fn(),
  createSignedUrl: vi.fn(),
  remove
};

function createStore(options: {
  database?: CareerDatabase;
  subject?: string;
  createId?: () => string;
  downloadFile?: (file: OpenAiFileRef) => Promise<Uint8Array>;
  inspectImage?: (
    bytes: Uint8Array,
    declaredMimeType?: string
  ) => Promise<ImageInspection>;
} = {}) {
  return createPrivateMediaStore(options.database ?? db, {
    subject: options.subject ?? owner,
    storage,
    createId: options.createId ?? (() => mediaId),
    downloadFile: options.downloadFile ?? vi.fn(async () => fixturePng),
    inspectImage: options.inspectImage ?? vi.fn(async () => pngInspection)
  });
}

beforeEach(() => {
  upload.mockReset();
  upload.mockResolvedValue(undefined);
  remove.mockReset();
  remove.mockResolvedValue(undefined);
});
afterEach(async () => db.resetForTests());
afterAll(async () => db.close());

describe("private media store", () => {
  it("downloads, inspects, and stores an OpenAI source file with its original bytes", async () => {
    const downloadFile = vi.fn(async () => fixturePng);
    const inspectImage = vi.fn(async () => pngInspection);
    const store = createStore({ downloadFile, inspectImage });

    const stored = await store.ingestOpenAiFile(openAiFile);

    expect(downloadFile).toHaveBeenCalledWith(openAiFile);
    expect(inspectImage).toHaveBeenCalledWith(expect.any(Buffer), "image/png");
    expect(stored.media).toMatchObject({
      id: mediaId,
      ownerSubject: owner,
      objectPath: `${owner}/ab/${mediaId}.png`,
      sha256,
      mimeType: "image/png",
      originalFilename: "campaign-image.png"
    });
    expect(stored.media.objectPath).toMatch(
      new RegExp(`^${owner}/[0-9a-f]{2}/${mediaId}\\.png$`)
    );
    expect(Buffer.isBuffer(stored.bytes)).toBe(true);
    expect(stored.bytes.equals(fixturePng)).toBe(true);
    expect(stored.createdObjectPath).toBe(stored.media.objectPath);
    expect(upload).toHaveBeenCalledWith(stored.media.objectPath, fixturePng, "image/png");
  });

  it("inspects direct bytes and derives the extension from content instead of the filename", async () => {
    const inspectImage = vi.fn(async () => pngInspection);
    const store = createStore({ inspectImage });

    const stored = await store.storeBytes(fixturePng, "../../caller-name.jpg");

    expect(inspectImage).toHaveBeenCalledWith(fixturePng);
    expect(stored.media.objectPath).toBe(`${owner}/ab/${mediaId}.png`);
    expect(stored.media.mimeType).toBe("image/png");
    expect(stored.media.originalFilename).toBe("../../caller-name.jpg");
    expect(upload).toHaveBeenCalledWith(stored.media.objectPath, fixturePng, "image/png");
  });

  it("deduplicates SHA-256 only within the owner boundary", async () => {
    const first = await createStore().storeBytes(fixturePng, "first.png");
    upload.mockClear();

    const reused = await createStore({ createId: () => randomUUID() })
      .storeBytes(fixturePng, "renamed.png");
    const foreign = await createStore({
      subject: otherOwner,
      createId: () => otherMediaId
    }).storeBytes(fixturePng, "other-owner.png");

    expect(reused.media.id).toBe(first.media.id);
    expect(reused.createdObjectPath).toBeUndefined();
    expect(foreign.media.id).toBe(otherMediaId);
    expect(foreign.media.objectPath).toBe(`${otherOwner}/ab/${otherMediaId}.png`);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(foreign.media.objectPath);
  });

  it("keeps caller filenames out of the safe owner-prefixed object path", async () => {
    const stored = await createStore().storeBytes(
      fixturePng,
      `../${otherOwner}/guessed-object.gif`
    );

    expect(stored.media.objectPath).toBe(`${owner}/ab/${mediaId}.png`);
    expect(stored.media.objectPath).not.toContain("..");
    expect(stored.media.objectPath).not.toContain(otherOwner);
    expect(stored.media.objectPath).not.toContain("guessed-object");
  });

  it("best-effort removes a provisional object when upload may commit before failing", async () => {
    const storageError = new DomainError(
      "MEDIA_STORAGE_ERROR",
      "Draft media storage operation failed"
    );
    upload.mockRejectedValueOnce(storageError);
    remove.mockRejectedValueOnce(new Error("private cleanup failure"));

    await expect(createStore().storeBytes(fixturePng, "image.png")).rejects.toBe(storageError);

    expect(remove).toHaveBeenCalledWith([`${owner}/ab/${mediaId}.png`]);
    expect(await db.postMedia.getByOwnerAndSha(owner, sha256)).toBeUndefined();
  });

  it("preserves reused rows and objects during best-effort cleanup", async () => {
    const original = await createStore().storeBytes(fixturePng, "first.png");
    const reused = await createStore({ createId: () => randomUUID() })
      .storeBytes(fixturePng, "renamed.png");
    upload.mockClear();
    remove.mockClear();

    await createStore().removeBestEffort([reused]);

    expect(reused.createdObjectPath).toBeUndefined();
    expect(await db.postMedia.get(original.media.id)).toEqual(original.media);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes only objects whose newly-created rows were deleted as unreferenced", async () => {
    const first = await createStore().storeBytes(fixturePng, "first.png");
    const secondMedia = {
      ...first.media,
      id: otherMediaId,
      objectPath: `${owner}/ab/${otherMediaId}.png`
    };
    const second: StoredPrivateMedia = {
      media: secondMedia,
      bytes: Buffer.from(fixturePng),
      createdObjectPath: secondMedia.objectPath
    };
    const deleteOwnedUnreferenced = vi.fn(async () => [first.media.id]);
    const partialDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;

    await createStore({ database: partialDatabase }).removeBestEffort([first, second]);

    expect(deleteOwnedUnreferenced).toHaveBeenCalledWith(owner, [
      first.media.id,
      second.media.id
    ]);
    expect(remove).toHaveBeenCalledWith([first.media.objectPath]);
  });

  it("swallows database cleanup failures without risking undeleted rows or objects", async () => {
    const stored = await createStore().storeBytes(fixturePng, "first.png");
    const deleteOwnedUnreferenced = vi.fn(async () => {
      throw new Error("private database cleanup failure");
    });
    const failingDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    await expect(
      createStore({ database: failingDatabase }).removeBestEffort([stored])
    ).resolves.toBeUndefined();

    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(stored.media.id)).toEqual(stored.media);
  });
});
