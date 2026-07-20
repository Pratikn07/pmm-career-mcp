import { randomUUID } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import { PostDraftVersionConflictError } from "../db/repositories.js";
import {
  createDraftService,
  type PostDraftMediaVersion,
  type PostDraftVersion,
  type PostVisibility
} from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import {
  checksumLinkedInPost,
  type LinkedInPostChecksumMedia
} from "../posts/post-checksum.js";
import { downloadOpenAiFile, type OpenAiFileRef } from "./file-download.js";
import { inspectLinkedInImage, type ImageInspection } from "./image-inspection.js";
import type { DraftMediaStorage } from "./storage.js";

export type AttachPostFilesInput = Readonly<{
  postId: string;
  expectedVersion: number;
  images: readonly OpenAiFileRef[];
  altTexts: readonly string[];
}>;

export type SetPostMediaInput = Readonly<{
  postId: string;
  expectedVersion: number;
  media: readonly Readonly<{ mediaId: string; altText: string }>[];
}>;

export type PostMediaServiceDependencies = Readonly<{
  subject: string;
  storage: DraftMediaStorage;
  downloadFile?: typeof downloadOpenAiFile;
  inspectImage?: typeof inspectLinkedInImage;
  createId?: () => string;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MEDIA = 4;
const MAX_ALT_TEXT_CHARACTERS = 120;

export type MediaPostDraftVersion = Omit<PostDraftVersion, "media"> & {
  media: readonly PostDraftMediaVersion[];
};

function validationError(field: string, reason: string): DomainError {
  return new DomainError("VALIDATION_ERROR", "Draft media input is invalid", { field, reason });
}

function normalizedAltText(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("media.altText", "must_be_text");
  }
  const normalized = value.normalize("NFC").trim();
  if (/[\r\n\u2028\u2029]/u.test(normalized)) {
    throw validationError("media.altText", "must_be_single_line");
  }
  const length = [...normalized].length;
  if (length < 1 || length > MAX_ALT_TEXT_CHARACTERS) {
    throw validationError("media.altText", "invalid_length");
  }
  return normalized;
}

function expectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError("post.expectedVersion", "must_be_positive_integer");
  }
  return value;
}

function postId(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError("post.id", "must_be_uuid");
  }
  return value;
}

function extensionFor(mimeType: ImageInspection["mimeType"]): "gif" | "jpg" | "png" {
  switch (mimeType) {
    case "image/gif": return "gif";
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
  }
}

function isPostVisibility(value: string): value is PostVisibility {
  return value === "PUBLIC" || value === "CONNECTIONS";
}

function safePersistenceError(): DomainError {
  return new DomainError("DATA_INTEGRITY", "Draft media could not be saved", {
    entity: "post_draft"
  });
}

export function createPostMediaService(
  database: CareerDatabase,
  dependencies: PostMediaServiceDependencies
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const downloadFile = dependencies.downloadFile ?? downloadOpenAiFile;
  const inspectImage = dependencies.inspectImage ?? inspectLinkedInImage;
  const createId = dependencies.createId ?? randomUUID;
  const drafts = createDraftService(database);

  function withMedia(version: PostDraftVersion): MediaPostDraftVersion {
    return version;
  }

  async function latestVersion(id: string, expected: number): Promise<MediaPostDraftVersion> {
    const versions = await database.postDrafts.listVersions(id);
    const latest = versions.at(-1);
    if (latest === undefined) {
      throw new DomainError("NOT_FOUND", "Post draft was not found", { entity: "post_draft" });
    }
    if (latest.version !== expected) {
      throw new DomainError("CONFLICT", "Post draft version is stale", {
        entity: "post_draft",
        expectedVersion: expected,
        actualVersion: latest.version
      });
    }
    const storedMedia = await database.postDraftMedia.listForVersion(latest.id, latest.version);
    if (storedMedia.some((item) => item.ownerSubject.toLowerCase() !== subject)) {
      throw new DomainError("NOT_FOUND", "Post draft was not found", { entity: "post_draft" });
    }
    const version = await drafts.getPostVersion(id, latest.version);
    if (version === undefined) {
      throw safePersistenceError();
    }
    return withMedia(version);
  }

  function checksum(
    draftId: string,
    version: number,
    text: string,
    visibility: PostVisibility,
    media: readonly LinkedInPostChecksumMedia[]
  ): string {
    return checksumLinkedInPost({ draftId, version, text, visibility, media });
  }

  async function createVersion(
    current: MediaPostDraftVersion,
    requestedMedia: readonly Readonly<{ mediaId: string; altText: string }>[]
  ): Promise<MediaPostDraftVersion> {
    if (!isPostVisibility(current.visibility)) {
      throw safePersistenceError();
    }
    const created = await database.postDrafts.createVersionWithMedia({
      draftId: current.id,
      expectedVersion: current.version,
      ownerSubject: subject,
      text: current.text,
      visibility: current.visibility,
      state: "draft",
      media: requestedMedia,
      checksum: (version, actualDraftId, media) => checksum(
        actualDraftId,
        version,
        current.text,
        current.visibility,
        media as readonly LinkedInPostChecksumMedia[]
      )
    });
    const result = await drafts.getPostVersion(created.post.draftId, created.post.version);
    if (result === undefined) throw safePersistenceError();
    return withMedia(result);
  }

  async function removeBestEffort(
    uploaded: readonly Readonly<{ mediaId?: string; objectPath: string }>[]
  ): Promise<void> {
    if (uploaded.length === 0) return;
    const withoutRow = uploaded.filter(({ mediaId }) => mediaId === undefined);
    const withRow = uploaded.filter((item): item is { mediaId: string; objectPath: string } => (
      item.mediaId !== undefined
    ));
    let removable = [...withoutRow.map(({ objectPath }) => objectPath)];
    try {
      const deletedIds = await database.postMedia.deleteOwnedUnreferenced(
        subject,
        withRow.map(({ mediaId }) => mediaId)
      );
      const deleted = new Set(deletedIds.map((id) => id.toLowerCase()));
      removable = removable.concat(withRow
        .filter(({ mediaId }) => deleted.has(mediaId.toLowerCase()))
        .map(({ objectPath }) => objectPath));
    } catch {
      // Keep objects whose database rows could not safely be removed.
    }
    if (removable.length === 0) return;
    try {
      await dependencies.storage.remove(removable);
    } catch {
      // Cleanup must never replace the original safe ingestion or persistence error.
    }
  }

  return {
    async attachFiles(input: AttachPostFilesInput): Promise<MediaPostDraftVersion> {
      const id = postId(input.postId);
      const expected = expectedVersion(input.expectedVersion);
      if (
        !Array.isArray(input.images)
        || input.images.length < 1
        || input.images.length > MAX_MEDIA
        || !Array.isArray(input.altTexts)
        || input.altTexts.length !== input.images.length
      ) {
        throw validationError("media", "images_and_alt_texts_must_match");
      }
      const altTexts = input.altTexts.map(normalizedAltText);
      const current = await latestVersion(id, expected);
      const uploaded: Array<{ mediaId?: string; objectPath: string }> = [];

      try {
        const requestedMedia: Array<{ mediaId: string; altText: string }> = [];
        for (let index = 0; index < input.images.length; index += 1) {
          const file = input.images[index]!;
          const bytes = await downloadFile(file);
          const inspected = await inspectImage(bytes, file.mime_type);
          let media = await database.postMedia.getByOwnerAndSha(subject, inspected.sha256);
          if (media === undefined) {
            const mediaId = createId();
            const objectPath = `${subject}/${inspected.sha256.slice(0, 2)}/${mediaId}.${extensionFor(inspected.mimeType)}`;
            const uploadedObject: { mediaId?: string; objectPath: string } = { objectPath };
            uploaded.push(uploadedObject);
            await dependencies.storage.upload(objectPath, bytes, inspected.mimeType);
            media = await database.postMedia.create({
              id: mediaId,
              ownerSubject: subject,
              objectPath,
              sha256: inspected.sha256,
              mimeType: inspected.mimeType,
              byteSize: inspected.byteSize,
              width: inspected.width,
              height: inspected.height,
              frameCount: inspected.frameCount,
              originalFilename: file.file_name ?? null
            });
            uploadedObject.mediaId = media.id;
          }
          requestedMedia.push({ mediaId: media.id, altText: altTexts[index]! });
        }
        return await createVersion(current, requestedMedia);
      } catch (error) {
        await removeBestEffort(uploaded);
        if (error instanceof PostDraftVersionConflictError) {
          throw new DomainError("CONFLICT", "Post draft version is stale", {
            entity: "post_draft"
          });
        }
        if (error instanceof DomainError) throw error;
        throw safePersistenceError();
      }
    },

    async setMedia(input: SetPostMediaInput): Promise<MediaPostDraftVersion> {
      const id = postId(input.postId);
      const expected = expectedVersion(input.expectedVersion);
      if (!Array.isArray(input.media) || input.media.length > MAX_MEDIA) {
        throw validationError("media", "too_many");
      }
      const normalized = input.media.map((item) => ({
        mediaId: item.mediaId,
        altText: normalizedAltText(item.altText)
      }));
      if (
        normalized.some(({ mediaId }) => !UUID_PATTERN.test(mediaId))
        || new Set(normalized.map(({ mediaId }) => mediaId.toLowerCase())).size !== normalized.length
      ) {
        throw validationError("media.mediaId", "must_be_unique_uuid");
      }
      const current = await latestVersion(id, expected);
      for (const item of normalized) {
        const media = await database.postMedia.get(item.mediaId);
        if (media === undefined || media.ownerSubject.toLowerCase() !== subject) {
          throw new DomainError("NOT_FOUND", "Draft media was not found", { entity: "post_media" });
        }
      }
      try {
        return await createVersion(current, normalized);
      } catch (error) {
        if (error instanceof PostDraftVersionConflictError) {
          throw new DomainError("CONFLICT", "Post draft version is stale", {
            entity: "post_draft"
          });
        }
        if (error instanceof DomainError) throw error;
        throw safePersistenceError();
      }
    },

    async getVersion(idInput: string, versionInput: number): Promise<MediaPostDraftVersion | undefined> {
      const id = postId(idInput);
      const version = expectedVersion(versionInput);
      const row = await database.postDrafts.getVersion(id, version);
      if (row === undefined) return undefined;
      const storedMedia = await database.postDraftMedia.listForVersion(row.id, row.version);
      if (storedMedia.some((item) => item.ownerSubject.toLowerCase() !== subject)) {
        return undefined;
      }
      const result = await drafts.getPostVersion(id, version);
      return result === undefined ? undefined : withMedia(result);
    }
  };
}

export type PostMediaService = ReturnType<typeof createPostMediaService>;
