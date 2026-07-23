import { createHash, randomUUID } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { PostMedia } from "../db/repositories.js";
import { DomainError } from "../domain/errors.js";
import {
  downloadOpenAiFile,
  MAX_OPENAI_FILE_BYTES,
  type OpenAiFileRef
} from "./file-download.js";
import {
  inspectLinkedInImage,
  isWithinLinkedInDecodedPixelLimit,
  MAX_LINKEDIN_IMAGE_FRAMES,
  type ImageInspection
} from "./image-inspection.js";
import type { DraftMediaStorage } from "./storage.js";

export type StoredPrivateMedia = Readonly<{
  media: PostMedia;
  bytes: Buffer;
  createdObjectPath?: string;
}>;

export type PrivateMediaStoreDependencies = Readonly<{
  subject: string;
  storage: DraftMediaStorage;
  downloadFile?: typeof downloadOpenAiFile;
  inspectImage?: typeof inspectLinkedInImage;
  createId?: () => string;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NORMALIZED_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function extensionFor(mimeType: unknown): "gif" | "jpg" | "png" | undefined {
  switch (mimeType) {
    case "image/gif": return "gif";
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
  }
}

function authRequired(): DomainError {
  return new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
}

function mediaValidationError(): DomainError {
  return new DomainError("MEDIA_VALIDATION_ERROR", "Draft image validation failed");
}

function safePersistenceError(): DomainError {
  return new DomainError("DATA_INTEGRITY", "Draft media could not be saved", {
    entity: "post_media"
  });
}

export function createPrivateMediaStore(
  database: CareerDatabase,
  dependencies: PrivateMediaStoreDependencies
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw authRequired();
  }
  const subject = dependencies.subject.toLowerCase();
  const downloadFile = dependencies.downloadFile ?? downloadOpenAiFile;
  const inspectImage = dependencies.inspectImage ?? inspectLinkedInImage;
  const createId = dependencies.createId ?? randomUUID;
  const createdItems = new WeakSet<StoredPrivateMedia>();

  function storedPrivateMedia(
    media: PostMedia,
    bytes: Buffer,
    createdObjectPath?: string
  ): StoredPrivateMedia {
    const stored = Object.freeze({
      media: Object.freeze({ ...media }),
      bytes,
      ...(createdObjectPath === undefined ? {} : { createdObjectPath })
    });
    if (createdObjectPath !== undefined) {
      createdItems.add(stored);
    }
    return stored;
  }

  function canonicalCreatedPath(media: PostMedia): string | undefined {
    if (
      media.ownerSubject !== subject
      || !NORMALIZED_UUID_PATTERN.test(media.id)
      || !/^[0-9a-f]{64}$/.test(media.sha256)
    ) {
      return undefined;
    }
    const extension = extensionFor(media.mimeType);
    if (extension === undefined) {
      return undefined;
    }
    return `${subject}/${media.sha256.slice(0, 2)}/${media.id}.${extension}`;
  }

  function validatedReconciliationRow(
    value: PostMedia,
    inspected: ImageInspection
  ): PostMedia | undefined {
    if (
      typeof value !== "object"
      || value === null
      || value.ownerSubject !== subject
      || !NORMALIZED_UUID_PATTERN.test(value.ownerSubject)
      || !NORMALIZED_UUID_PATTERN.test(value.id)
      || !/^[0-9a-f]{64}$/.test(value.sha256)
      || value.sha256 !== inspected.sha256
      || value.mimeType !== inspected.mimeType
      || value.byteSize !== inspected.byteSize
      || value.width !== inspected.width
      || value.height !== inspected.height
      || value.frameCount !== inspected.frameCount
    ) {
      return undefined;
    }
    const canonicalPath = canonicalCreatedPath(value);
    if (canonicalPath === undefined || value.objectPath !== canonicalPath) {
      return undefined;
    }
    return value;
  }

  function snapshotDirectBytes(bytes: Buffer): Buffer {
    if (
      !Buffer.isBuffer(bytes)
      || bytes.byteLength < 1
      || bytes.byteLength > MAX_OPENAI_FILE_BYTES
    ) {
      throw mediaValidationError();
    }
    return Buffer.from(bytes);
  }

  function snapshotDownloadedBytes(bytes: Uint8Array): Buffer {
    if (
      !(bytes instanceof Uint8Array)
      || bytes.byteLength < 1
      || bytes.byteLength > MAX_OPENAI_FILE_BYTES
    ) {
      throw mediaValidationError();
    }
    return Buffer.from(bytes);
  }

  function validatedInspection(
    value: ImageInspection,
    bytes: Buffer
  ): Readonly<{ inspected: ImageInspection; extension: "gif" | "jpg" | "png" }> {
    const candidate = value as Partial<ImageInspection> | null;
    const mimeType = candidate?.mimeType;
    const width = candidate?.width;
    const height = candidate?.height;
    const frameCount = candidate?.frameCount;
    const byteSize = candidate?.byteSize;
    const sha256 = candidate?.sha256;
    const extension = extensionFor(mimeType);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      candidate === null
      || extension === undefined
      || typeof sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(sha256)
      || sha256 !== actualSha256
      || byteSize !== bytes.byteLength
      || !Number.isSafeInteger(width)
      || (width ?? 0) < 1
      || !Number.isSafeInteger(height)
      || (height ?? 0) < 1
      || !Number.isSafeInteger(frameCount)
      || (frameCount ?? 0) < 1
      || (frameCount ?? 0) > MAX_LINKEDIN_IMAGE_FRAMES
      || !isWithinLinkedInDecodedPixelLimit(
        width ?? Number.NaN,
        height ?? Number.NaN,
        frameCount ?? Number.NaN
      )
    ) {
      throw mediaValidationError();
    }
    const inspected: ImageInspection = Object.freeze({
      mimeType: mimeType as ImageInspection["mimeType"],
      width: width as number,
      height: height as number,
      frameCount: frameCount as number,
      byteSize: byteSize as number,
      sha256
    });
    return Object.freeze({ inspected, extension });
  }

  async function removeProvisionalObject(objectPath: string): Promise<void> {
    try {
      await dependencies.storage.remove([objectPath]);
    } catch {
      // Cleanup must not replace the original ingestion error.
    }
  }

  async function storeInspectedBytes(
    bytes: Buffer,
    originalFilename: string | null,
    declaredMimeType?: string
  ): Promise<StoredPrivateMedia> {
    const inspectorBytes = Buffer.from(bytes);
    const rawInspection = declaredMimeType === undefined
      ? await inspectImage(inspectorBytes)
      : await inspectImage(inspectorBytes, declaredMimeType);
    const { inspected, extension } = validatedInspection(rawInspection, bytes);
    const existing = await database.postMedia.getByOwnerAndSha(subject, inspected.sha256);
    if (existing !== undefined) {
      return storedPrivateMedia(existing, bytes);
    }

    const createdId = createId();
    if (!UUID_PATTERN.test(createdId)) {
      throw safePersistenceError();
    }
    const mediaId = createdId.toLowerCase();
    const objectPath = (
      `${subject}/${inspected.sha256.slice(0, 2)}/${mediaId}.${extension}`
    );

    try {
      await dependencies.storage.upload(objectPath, bytes, inspected.mimeType);
    } catch (error) {
      await removeProvisionalObject(objectPath);
      throw error;
    }

    try {
      const media = await database.postMedia.create({
        id: mediaId,
        ownerSubject: subject,
        objectPath,
        sha256: inspected.sha256,
        mimeType: inspected.mimeType,
        byteSize: inspected.byteSize,
        width: inspected.width,
        height: inspected.height,
        frameCount: inspected.frameCount,
        originalFilename
      });
      return storedPrivateMedia(media, bytes, objectPath);
    } catch (error) {
      let reconciled: PostMedia | undefined;
      try {
        reconciled = await database.postMedia.getByOwnerAndSha(subject, inspected.sha256);
      } catch {
        throw error;
      }
      if (
        reconciled === undefined
      ) {
        await removeProvisionalObject(objectPath);
        throw error;
      }
      const validRow = validatedReconciliationRow(reconciled, inspected);
      if (validRow === undefined) {
        throw error;
      }
      if (validRow.id === mediaId && validRow.objectPath === objectPath) {
        return storedPrivateMedia(validRow, bytes, objectPath);
      }
      await removeProvisionalObject(objectPath);
      return storedPrivateMedia(validRow, bytes);
    }
  }

  return {
    async ingestOpenAiFile(file: OpenAiFileRef): Promise<StoredPrivateMedia> {
      const bytes = snapshotDownloadedBytes(await downloadFile(file));
      return await storeInspectedBytes(bytes, file.file_name ?? null, file.mime_type);
    },

    async storeBytes(bytes: Buffer, originalFilename: string): Promise<StoredPrivateMedia> {
      const snapshot = snapshotDirectBytes(bytes);
      return await storeInspectedBytes(snapshot, originalFilename);
    },

    async removeBestEffort(items: readonly StoredPrivateMedia[]): Promise<void> {
      const createdById = new Map(items.flatMap((item) => {
        if (!createdItems.has(item)) {
          return [];
        }
        const canonicalPath = canonicalCreatedPath(item.media);
        if (
          canonicalPath === undefined
          || item.createdObjectPath === undefined
          || item.media.objectPath !== canonicalPath
          || item.createdObjectPath !== canonicalPath
        ) {
          return [];
        }
        return [[item.media.id.toLowerCase(), item] as const];
      }));
      if (createdById.size === 0) return;

      let removable: string[];
      try {
        const deletedIds: unknown = await database.postMedia.deleteOwnedUnreferenced(
          subject,
          [...createdById.keys()]
        );
        if (
          !Array.isArray(deletedIds)
          || deletedIds.some((id) => (
            typeof id !== "string" || !NORMALIZED_UUID_PATTERN.test(id)
          ))
        ) {
          return;
        }
        removable = deletedIds.flatMap((id) => {
          const item = createdById.get(id);
          return item === undefined || item.createdObjectPath === undefined
            ? []
            : [item.createdObjectPath];
        });
      } catch {
        return;
      }
      if (removable.length === 0) return;
      try {
        await dependencies.storage.remove(removable);
      } catch {
        // Cleanup must not replace the original persistence error.
      }
    }
  };
}

export type PrivateMediaStore = ReturnType<typeof createPrivateMediaStore>;
