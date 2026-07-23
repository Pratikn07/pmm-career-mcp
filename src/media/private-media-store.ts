import { randomUUID } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { PostMedia } from "../db/repositories.js";
import { DomainError } from "../domain/errors.js";
import { downloadOpenAiFile, type OpenAiFileRef } from "./file-download.js";
import { inspectLinkedInImage, type ImageInspection } from "./image-inspection.js";
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

function extensionFor(mimeType: ImageInspection["mimeType"]): "gif" | "jpg" | "png" {
  switch (mimeType) {
    case "image/gif": return "gif";
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
  }
}

function authRequired(): DomainError {
  return new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
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
    const inspected = declaredMimeType === undefined
      ? await inspectImage(bytes)
      : await inspectImage(bytes, declaredMimeType);
    const existing = await database.postMedia.getByOwnerAndSha(subject, inspected.sha256);
    if (existing !== undefined) {
      return { media: existing, bytes };
    }

    const mediaId = createId();
    if (!UUID_PATTERN.test(mediaId)) {
      throw safePersistenceError();
    }
    const objectPath = (
      `${subject}/${inspected.sha256.slice(0, 2)}/${mediaId}.${extensionFor(inspected.mimeType)}`
    );

    try {
      await dependencies.storage.upload(objectPath, bytes, inspected.mimeType);
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
      return { media, bytes, createdObjectPath: objectPath };
    } catch (error) {
      await removeProvisionalObject(objectPath);
      throw error;
    }
  }

  return {
    async ingestOpenAiFile(file: OpenAiFileRef): Promise<StoredPrivateMedia> {
      const bytes = Buffer.from(await downloadFile(file));
      return await storeInspectedBytes(bytes, file.file_name ?? null, file.mime_type);
    },

    async storeBytes(bytes: Buffer, originalFilename: string): Promise<StoredPrivateMedia> {
      return await storeInspectedBytes(bytes, originalFilename);
    },

    async removeBestEffort(items: readonly StoredPrivateMedia[]): Promise<void> {
      const createdById = new Map(items.flatMap((item) => {
        if (
          item.createdObjectPath === undefined
          || item.createdObjectPath !== item.media.objectPath
          || item.media.ownerSubject.toLowerCase() !== subject
          || !item.createdObjectPath.startsWith(`${subject}/`)
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
