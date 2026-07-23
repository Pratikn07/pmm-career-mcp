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
  MAX_LINKEDIN_IMAGE_FRAMES,
  MAX_LINKEDIN_IMAGE_PIXELS_EXCLUSIVE,
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
      || !UUID_PATTERN.test(media.id)
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
    const inspected = value as Partial<ImageInspection> | null;
    const extension = extensionFor(inspected?.mimeType);
    const decodedPixels = (inspected?.width ?? Number.NaN) * (
      inspected?.height ?? Number.NaN
    );
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      inspected === null
      || extension === undefined
      || typeof inspected.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(inspected.sha256)
      || inspected.sha256 !== actualSha256
      || inspected.byteSize !== bytes.byteLength
      || !Number.isSafeInteger(inspected.width)
      || (inspected.width ?? 0) < 1
      || !Number.isSafeInteger(inspected.height)
      || (inspected.height ?? 0) < 1
      || !Number.isSafeInteger(decodedPixels)
      || decodedPixels >= MAX_LINKEDIN_IMAGE_PIXELS_EXCLUSIVE
      || !Number.isSafeInteger(inspected.frameCount)
      || (inspected.frameCount ?? 0) < 1
      || (inspected.frameCount ?? 0) > MAX_LINKEDIN_IMAGE_FRAMES
    ) {
      throw mediaValidationError();
    }
    return { inspected: value, extension };
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
    const rawInspection = declaredMimeType === undefined
      ? await inspectImage(bytes)
      : await inspectImage(bytes, declaredMimeType);
    const { inspected, extension } = validatedInspection(rawInspection, bytes);
    const existing = await database.postMedia.getByOwnerAndSha(subject, inspected.sha256);
    if (existing !== undefined) {
      return storedPrivateMedia(existing, bytes);
    }

    const mediaId = createId();
    if (!UUID_PATTERN.test(mediaId)) {
      throw safePersistenceError();
    }
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
      if (
        typeof reconciled.ownerSubject !== "string"
        || reconciled.ownerSubject.toLowerCase() !== subject
        || reconciled.sha256 !== inspected.sha256
      ) {
        throw error;
      }
      if (reconciled.objectPath === objectPath) {
        return storedPrivateMedia(reconciled, bytes, objectPath);
      }
      await removeProvisionalObject(objectPath);
      return storedPrivateMedia(reconciled, bytes);
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

      let deletedIds: readonly string[];
      try {
        deletedIds = await database.postMedia.deleteOwnedUnreferenced(
          subject,
          [...createdById.keys()]
        );
      } catch {
        return;
      }

      const removable = deletedIds.flatMap((id) => {
        const item = createdById.get(id.toLowerCase());
        return item === undefined || item.createdObjectPath === undefined
          ? []
          : [item.createdObjectPath];
      });
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
