import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerDatabase } from "../../src/db/client.js";
import type { PostMedia } from "../../src/db/repositories.js";
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
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_PIXELS_EXCLUSIVE = 36_152_320;
const MAX_IMAGE_FRAMES = 250;
const fixturePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = createHash("sha256").update(fixturePng).digest("hex");
const shaShard = sha256.slice(0, 2);
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

function mediaRow(
  id = mediaId,
  objectPath = `${owner}/${shaShard}/${id}.png`
): PostMedia {
  return {
    id,
    ownerSubject: owner,
    objectPath,
    sha256,
    mimeType: "image/png",
    byteSize: fixturePng.byteLength,
    width: pngInspection.width,
    height: pngInspection.height,
    frameCount: pngInspection.frameCount,
    originalFilename: "image.png",
    createdAt: "2026-07-23T00:00:00.000Z"
  };
}

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
      objectPath: `${owner}/${shaShard}/${mediaId}.png`,
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

  it("rejects an OpenAI declared MIME mismatch before dedupe or upload", async () => {
    const mismatchError = new DomainError(
      "MEDIA_VALIDATION_ERROR",
      "Draft image validation failed"
    );
    const inspectImage = vi.fn(async (
      _bytes: Uint8Array,
      declaredMimeType?: string
    ): Promise<ImageInspection> => {
      if (declaredMimeType !== "image/png") throw mismatchError;
      return pngInspection;
    });

    await expect(createStore({ inspectImage }).ingestOpenAiFile({
      ...openAiFile,
      mime_type: "image/jpeg"
    })).rejects.toBe(mismatchError);

    expect(inspectImage).toHaveBeenCalledWith(expect.any(Buffer), "image/jpeg");
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("inspects direct bytes and derives the extension from content instead of the filename", async () => {
    const inspectImage = vi.fn(async () => pngInspection);
    const store = createStore({ inspectImage });

    const stored = await store.storeBytes(fixturePng, "../../caller-name.jpg");

    expect(inspectImage).toHaveBeenCalledWith(fixturePng);
    expect(stored.media.objectPath).toBe(`${owner}/${shaShard}/${mediaId}.png`);
    expect(stored.media.mimeType).toBe("image/png");
    expect(stored.media.originalFilename).toBe("../../caller-name.jpg");
    expect(upload).toHaveBeenCalledWith(stored.media.objectPath, fixturePng, "image/png");
  });

  it.each([
    ["a non-Buffer value", new Uint8Array(fixturePng)],
    ["an empty Buffer", Buffer.alloc(0)],
    ["an over-limit Buffer", Buffer.allocUnsafe(MAX_MEDIA_BYTES + 1)]
  ])("rejects %s before inspection or upload", async (_label, bytes) => {
    const inspectImage = vi.fn(async () => pngInspection);
    let rejection: unknown;

    try {
      await createStore({ inspectImage }).storeBytes(bytes as Buffer, "image.png");
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({ code: "MEDIA_VALIDATION_ERROR" });
    expect(inspectImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed when the inspector returns no result", async () => {
    const inspectImage = vi.fn(async () => undefined as unknown as ImageInspection);
    const getByOwnerAndSha = vi.fn();
    const guardedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha }
    } as CareerDatabase;

    await expect(createStore({
      database: guardedDatabase,
      inspectImage
    }).storeBytes(fixturePng, "image.png")).rejects.toMatchObject({
      code: "MEDIA_VALIDATION_ERROR"
    });

    expect(getByOwnerAndSha).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("snapshots direct bytes before async inspection and caller mutation", async () => {
    const callerBytes = Buffer.from(fixturePng);
    const expectedBytes = Buffer.from(callerBytes);
    const expectedSha = createHash("sha256").update(expectedBytes).digest("hex");
    let inspectionStarted!: () => void;
    let finishInspection!: () => void;
    const started = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });
    const inspectImage = vi.fn(async (bytes: Uint8Array): Promise<ImageInspection> => {
      const inspectedSnapshot = Buffer.from(bytes);
      inspectionStarted();
      await finish;
      return {
        ...pngInspection,
        byteSize: inspectedSnapshot.byteLength,
        sha256: createHash("sha256").update(inspectedSnapshot).digest("hex")
      };
    });

    const storing = createStore({ inspectImage }).storeBytes(callerBytes, "image.png");
    await started;
    callerBytes.fill(0);
    finishInspection();
    const stored = await storing;

    expect(inspectImage.mock.calls[0]?.[0]).not.toBe(callerBytes);
    expect(stored.bytes.equals(expectedBytes)).toBe(true);
    expect(stored.media.sha256).toBe(expectedSha);
    expect(stored.media.byteSize).toBe(expectedBytes.byteLength);
    expect(Buffer.from(upload.mock.calls[0]?.[1] ?? []).equals(expectedBytes)).toBe(true);
  });

  it("isolates upload bytes and validated metadata from inspector mutation during lookup", async () => {
    const expectedBytes = Buffer.from(fixturePng);
    const mutableInspection = { ...pngInspection };
    let retainedInspectorBytes: Uint8Array | undefined;
    const inspectImage = vi.fn(async (bytes: Uint8Array): Promise<ImageInspection> => {
      retainedInspectorBytes = bytes;
      return mutableInspection;
    });
    let lookupStarted!: () => void;
    let finishLookup!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const getByOwnerAndSha = vi.fn(async () => {
      lookupStarted();
      await finish;
      return undefined;
    });
    const delayedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha }
    } as CareerDatabase;

    const storing = createStore({
      database: delayedDatabase,
      inspectImage
    }).storeBytes(expectedBytes, "image.png");
    await started;
    retainedInspectorBytes!.fill(0);
    Object.assign(mutableInspection, {
      mimeType: "image/gif",
      width: 2,
      height: 2,
      frameCount: 1,
      sha256: "0".repeat(64)
    });
    finishLookup();
    const stored = await storing;

    expect(retainedInspectorBytes).not.toBe(stored.bytes);
    expect(stored.bytes.equals(expectedBytes)).toBe(true);
    expect(stored.media).toMatchObject({
      sha256,
      mimeType: "image/png",
      byteSize: expectedBytes.byteLength,
      width: pngInspection.width,
      height: pngInspection.height,
      frameCount: pngInspection.frameCount,
      objectPath: `${owner}/${shaShard}/${mediaId}.png`
    });
    expect(upload).toHaveBeenCalledWith(
      `${owner}/${shaShard}/${mediaId}.png`,
      expect.any(Buffer),
      "image/png"
    );
    expect(Buffer.from(upload.mock.calls[0]?.[1] ?? []).equals(expectedBytes)).toBe(true);
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
    expect(foreign.media.objectPath).toBe(`${otherOwner}/${shaShard}/${otherMediaId}.png`);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(foreign.media.objectPath);
  });

  it("keeps caller filenames out of the safe owner-prefixed object path", async () => {
    const stored = await createStore().storeBytes(
      fixturePng,
      `../${otherOwner}/guessed-object.gif`
    );

    expect(stored.media.objectPath).toBe(`${owner}/${shaShard}/${mediaId}.png`);
    expect(stored.media.objectPath).not.toContain("..");
    expect(stored.media.objectPath).not.toContain(otherOwner);
    expect(stored.media.objectPath).not.toContain("guessed-object");
  });

  it("rejects invalid subjects before constructing a usable store", () => {
    const inspectImage = vi.fn(async () => pngInspection);

    expect(() => createStore({ subject: "../foreign", inspectImage })).toThrowError(
      expect.objectContaining({ code: "AUTH_REQUIRED" })
    );

    expect(inspectImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an invalid generated media UUID before upload", async () => {
    const inspectImage = vi.fn(async () => pngInspection);

    await expect(createStore({
      createId: () => "../guessed-object",
      inspectImage
    }).storeBytes(fixturePng, "image.png")).rejects.toMatchObject({
      code: "DATA_INTEGRITY"
    });

    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase generated UUID for storage, rows, and downstream cleanup", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({
      database: spyDatabase,
      createId: () => mediaId.toUpperCase()
    });

    const stored = await store.storeBytes(fixturePng, "image.png");

    expect(stored.media.id).toBe(mediaId);
    expect(stored.media.objectPath).toBe(`${owner}/${shaShard}/${mediaId}.png`);
    expect(stored.createdObjectPath).toBe(stored.media.objectPath);

    await store.removeBestEffort([stored]);

    expect(deleteOwnedUnreferenced).toHaveBeenCalledWith(owner, [mediaId]);
    expect(remove).toHaveBeenCalledWith([`${owner}/${shaShard}/${mediaId}.png`]);
  });

  it.each([
    ["uppercase SHA-256", { sha256: sha256.toUpperCase() }],
    ["short SHA-256", { sha256: "a".repeat(63) }],
    ["SHA-256 not matching the snapshot", { sha256: "0".repeat(64) }],
    ["unsupported MIME", { mimeType: "image/webp" }],
    ["mismatched byte size", { byteSize: fixturePng.byteLength + 1 }],
    ["zero width", { width: 0 }],
    ["non-integer height", { height: 1.5 }],
    ["excess decoded pixels", { width: MAX_DECODED_PIXELS_EXCLUSIVE, height: 1 }],
    ["multi-frame decoded pixels at the exclusive boundary", {
      width: MAX_DECODED_PIXELS_EXCLUSIVE / 2,
      height: 1,
      frameCount: 2
    }],
    ["overflowing decoded pixel arithmetic", {
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      frameCount: MAX_IMAGE_FRAMES
    }],
    ["zero frame count", { frameCount: 0 }],
    ["excess frame count", { frameCount: MAX_IMAGE_FRAMES + 1 }]
  ])("rejects inspector output with %s before dedupe or path creation", async (_label, patch) => {
    const inspectImage = vi.fn(async () => ({
      ...pngInspection,
      ...patch
    } as ImageInspection));
    const getByOwnerAndSha = vi.fn();
    const guardedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha }
    } as CareerDatabase;

    await expect(createStore({
      database: guardedDatabase,
      inspectImage
    }).storeBytes(fixturePng, "image.png")).rejects.toMatchObject({
      code: "MEDIA_VALIDATION_ERROR"
    });

    expect(getByOwnerAndSha).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("accepts the exact maximum multi-frame decoded-pixel count below the exclusive limit", async () => {
    const width = (MAX_DECODED_PIXELS_EXCLUSIVE - 1) / 3;
    const inspection: ImageInspection = {
      ...pngInspection,
      width,
      height: 1,
      frameCount: 3
    };
    expect(Number.isInteger(width)).toBe(true);
    expect(BigInt(width) * 3n).toBe(BigInt(MAX_DECODED_PIXELS_EXCLUSIVE - 1));

    const stored = await createStore({
      inspectImage: vi.fn(async () => inspection)
    }).storeBytes(fixturePng, "animated.png");

    expect(stored.media).toMatchObject({
      width,
      height: 1,
      frameCount: 3
    });
  });

  it("best-effort removes a provisional object when upload may commit before failing", async () => {
    const storageError = new DomainError(
      "MEDIA_STORAGE_ERROR",
      "Draft media storage operation failed"
    );
    upload.mockRejectedValueOnce(storageError);
    remove.mockRejectedValueOnce(new Error("private cleanup failure"));

    await expect(createStore().storeBytes(fixturePng, "image.png")).rejects.toBe(storageError);

    expect(remove).toHaveBeenCalledWith([`${owner}/${shaShard}/${mediaId}.png`]);
    expect(await db.postMedia.getByOwnerAndSha(owner, sha256)).toBeUndefined();
  });

  it("retains an ambiguously committed object when row reconciliation finds its exact own row", async () => {
    const provisionalPath = `${owner}/${shaShard}/${mediaId}.png`;
    const committed = mediaRow(mediaId, provisionalPath);
    const createError = new Error("private create response failure");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(committed);
    const create = vi.fn().mockRejectedValueOnce(createError);
    const ambiguousDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as CareerDatabase;

    const stored = await createStore({ database: ambiguousDatabase })
      .storeBytes(fixturePng, "image.png");

    expect(stored.media).toEqual(committed);
    expect(stored.createdObjectPath).toBe(provisionalPath);
    expect(stored.bytes.equals(fixturePng)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(getByOwnerAndSha).toHaveBeenCalledTimes(2);
  });

  it("removes only the provisional object when reconciliation finds a concurrent own SHA winner", async () => {
    const provisionalPath = `${owner}/${shaShard}/${mediaId}.png`;
    const concurrent = mediaRow(otherMediaId, `${owner}/${shaShard}/${otherMediaId}.png`);
    const createError = new Error("private unique race");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(concurrent);
    const create = vi.fn().mockRejectedValueOnce(createError);
    const racingDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as CareerDatabase;

    const stored = await createStore({ database: racingDatabase })
      .storeBytes(fixturePng, "image.png");

    expect(stored.media).toEqual(concurrent);
    expect(stored.createdObjectPath).toBeUndefined();
    expect(remove).toHaveBeenCalledWith([provisionalPath]);
    expect(remove.mock.calls.flatMap(([paths]) => paths)).not.toContain(concurrent.objectPath);
  });

  it.each([
    ["the provisional path belongs to a different row ID", () => mediaRow(
      otherMediaId,
      `${owner}/${shaShard}/${mediaId}.png`
    )],
    ["the object path contains traversal", () => mediaRow(
      otherMediaId,
      `${owner}/${shaShard}/../${otherMediaId}.png`
    )],
    ["the object path uses a foreign owner prefix", () => mediaRow(
      otherMediaId,
      `${otherOwner}/${shaShard}/${otherMediaId}.png`
    )],
    ["the MIME metadata differs", () => ({
      ...mediaRow(otherMediaId, `${owner}/${shaShard}/${otherMediaId}.gif`),
      mimeType: "image/gif"
    })],
    ["the byte size differs", () => ({
      ...mediaRow(otherMediaId),
      byteSize: fixturePng.byteLength + 1
    })],
    ["the width differs", () => ({
      ...mediaRow(otherMediaId),
      width: pngInspection.width + 1
    })],
    ["the height differs", () => ({
      ...mediaRow(otherMediaId),
      height: pngInspection.height + 1
    })],
    ["the frame count differs", () => ({
      ...mediaRow(otherMediaId),
      frameCount: pngInspection.frameCount + 1
    })],
    ["the row UUID is invalid", () => mediaRow(
      "not-a-uuid",
      `${owner}/${shaShard}/not-a-uuid.png`
    )],
    ["the row UUID is not normalized", () => mediaRow(
      otherMediaId.toUpperCase(),
      `${owner}/${shaShard}/${otherMediaId.toUpperCase()}.png`
    )],
    ["the owner UUID is not normalized", () => ({
      ...mediaRow(otherMediaId),
      ownerSubject: owner.toUpperCase()
    })]
  ])("retains the provisional object and original create error when %s", async (_label, row) => {
    const createError = new Error("private row create failure");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row());
    const create = vi.fn().mockRejectedValueOnce(createError);
    const malformedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as unknown as CareerDatabase;

    await expect(
      createStore({ database: malformedDatabase }).storeBytes(fixturePng, "image.png")
    ).rejects.toBe(createError);

    expect(remove).not.toHaveBeenCalled();
    expect(getByOwnerAndSha).toHaveBeenCalledTimes(2);
  });

  it("removes the provisional object and preserves the create error after confirmed row absence", async () => {
    const provisionalPath = `${owner}/${shaShard}/${mediaId}.png`;
    const createError = new Error("private row create failure");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const create = vi.fn().mockRejectedValueOnce(createError);
    const failingDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as CareerDatabase;

    await expect(
      createStore({ database: failingDatabase }).storeBytes(fixturePng, "image.png")
    ).rejects.toBe(createError);

    expect(remove).toHaveBeenCalledWith([provisionalPath]);
    expect(getByOwnerAndSha).toHaveBeenCalledTimes(2);
  });

  it("retains the provisional object and preserves the create error when row state is unknown", async () => {
    const createError = new Error("private row create failure");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("private reconciliation failure"));
    const create = vi.fn().mockRejectedValueOnce(createError);
    const unknownDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as CareerDatabase;

    await expect(
      createStore({ database: unknownDatabase }).storeBytes(fixturePng, "image.png")
    ).rejects.toBe(createError);

    expect(remove).not.toHaveBeenCalled();
    expect(getByOwnerAndSha).toHaveBeenCalledTimes(2);
  });

  it("retains the provisional object and original create error for malformed reconciliation data", async () => {
    const createError = new Error("private row create failure");
    const getByOwnerAndSha = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...mediaRow(), ownerSubject: undefined });
    const create = vi.fn().mockRejectedValueOnce(createError);
    const malformedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, getByOwnerAndSha, create }
    } as unknown as CareerDatabase;

    await expect(
      createStore({ database: malformedDatabase }).storeBytes(fixturePng, "image.png")
    ).rejects.toBe(createError);

    expect(remove).not.toHaveBeenCalled();
  });

  it("cleans only a failed provisional create and preserves an existing referenced object", async () => {
    const existingStore = createStore();
    const existing = await existingStore.storeBytes(fixturePng, "existing.png");
    const referenced = await db.postDrafts.createVersionWithMedia({
      ownerSubject: owner,
      text: "Referenced media",
      visibility: "CONNECTIONS",
      state: "draft",
      media: [{ mediaId: existing.media.id, altText: "Referenced" }],
      checksum: "referenced-v1"
    });
    upload.mockClear();
    remove.mockClear();

    const secondBytes = Buffer.concat([fixturePng, Buffer.of(2)]);
    const secondInspection: ImageInspection = {
      ...pngInspection,
      byteSize: secondBytes.byteLength,
      sha256: createHash("sha256").update(secondBytes).digest("hex")
    };
    const createError = new Error("private new-row failure");
    const create = vi.fn().mockRejectedValueOnce(createError);
    const failingDatabase = {
      ...db,
      postMedia: { ...db.postMedia, create }
    } as CareerDatabase;

    await expect(createStore({
      database: failingDatabase,
      createId: () => otherMediaId,
      inspectImage: vi.fn(async () => secondInspection)
    }).storeBytes(secondBytes, "new.png")).rejects.toBe(createError);

    const provisionalPath = `${owner}/${secondInspection.sha256.slice(0, 2)}/${otherMediaId}.png`;
    expect(remove).toHaveBeenCalledWith([provisionalPath]);
    expect(remove.mock.calls.flatMap(([paths]) => paths)).not.toContain(existing.media.objectPath);
    expect(await db.postMedia.get(existing.media.id)).toEqual(existing.media);
    expect(referenced.media.map(({ mediaId }) => mediaId)).toEqual([existing.media.id]);
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

  it("ignores a forged created marker added to a deduped result", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: spyDatabase });
    const created = await store.storeBytes(fixturePng, "first.png");
    const reused = await store.storeBytes(fixturePng, "renamed.png");
    const forged: StoredPrivateMedia = {
      ...reused,
      createdObjectPath: reused.media.objectPath
    };

    await store.removeBestEffort([forged]);

    expect(deleteOwnedUnreferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(created.media.id)).toEqual(created.media);
  });

  it("ignores a copied created result even when every field is unchanged", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: spyDatabase });
    const created = await store.storeBytes(fixturePng, "first.png");
    const copied: StoredPrivateMedia = { ...created };

    await store.removeBestEffort([copied]);

    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.media)).toBe(true);
    expect(deleteOwnedUnreferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(created.media.id)).toEqual(created.media);
  });

  it("ignores a created result passed to a different store instance", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const creatingStore = createStore({ database: spyDatabase });
    const otherStore = createStore({ database: spyDatabase });
    const created = await creatingStore.storeBytes(fixturePng, "first.png");

    await otherStore.removeBestEffort([created]);

    expect(deleteOwnedUnreferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(created.media.id)).toEqual(created.media);
  });

  it("ignores copied traversal and noncanonical object paths", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: spyDatabase });
    const created = await store.storeBytes(fixturePng, "first.png");
    const traversalPath = `${owner}/${shaShard}/../${mediaId}.png`;
    const forged: StoredPrivateMedia = {
      ...created,
      media: { ...created.media, objectPath: traversalPath },
      createdObjectPath: traversalPath
    };

    await store.removeBestEffort([forged]);

    expect(deleteOwnedUnreferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(created.media.id)).toEqual(created.media);
  });

  it("ignores malformed unbranded cleanup values without throwing", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: spyDatabase });

    await expect(store.removeBestEffort([
      {} as StoredPrivateMedia
    ])).resolves.toBeUndefined();

    expect(deleteOwnedUnreferenced).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("cleans an exact newly-created result returned by the same store", async () => {
    const deleteOwnedUnreferenced = vi.fn(db.postMedia.deleteOwnedUnreferenced);
    const spyDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: spyDatabase });
    const created = await store.storeBytes(fixturePng, "first.png");

    await store.removeBestEffort([created]);

    expect(deleteOwnedUnreferenced).toHaveBeenCalledWith(owner, [created.media.id]);
    expect(remove).toHaveBeenCalledWith([created.media.objectPath]);
    expect(await db.postMedia.get(created.media.id)).toBeUndefined();
  });

  it.each([
    ["a non-array object", { deleted: [mediaId] }],
    ["null", null],
    ["a non-string array member", [42]],
    ["an invalid UUID", ["not-a-uuid"]],
    ["a non-normalized UUID", [mediaId.toUpperCase()]]
  ])("stops cleanup safely when deletion returns %s", async (_label, output) => {
    const deleteOwnedUnreferenced = vi.fn(async () => output as unknown as string[]);
    const malformedDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({ database: malformedDatabase });
    const created = await store.storeBytes(fixturePng, "first.png");
    remove.mockClear();

    await expect(store.removeBestEffort([created])).resolves.toBeUndefined();

    expect(deleteOwnedUnreferenced).toHaveBeenCalledWith(owner, [created.media.id]);
    expect(remove).not.toHaveBeenCalled();
    expect(await db.postMedia.get(created.media.id)).toEqual(created.media);
  });

  it("removes only objects whose newly-created rows were deleted as unreferenced", async () => {
    const secondBytes = Buffer.concat([fixturePng, Buffer.of(1)]);
    const secondInspection: ImageInspection = {
      ...pngInspection,
      byteSize: secondBytes.byteLength,
      sha256: createHash("sha256").update(secondBytes).digest("hex")
    };
    const inspectImage = vi.fn(async (bytes: Uint8Array) => (
      bytes.byteLength === fixturePng.byteLength ? pngInspection : secondInspection
    ));
    const ids = [mediaId, otherMediaId];
    const deleteOwnedUnreferenced = vi.fn(async () => [mediaId]);
    const partialDatabase = {
      ...db,
      postMedia: { ...db.postMedia, deleteOwnedUnreferenced }
    } as CareerDatabase;
    const store = createStore({
      database: partialDatabase,
      createId: () => ids.shift()!,
      inspectImage
    });
    const first = await store.storeBytes(fixturePng, "first.png");
    const second = await store.storeBytes(secondBytes, "second.png");

    await store.removeBestEffort([first, second]);

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
