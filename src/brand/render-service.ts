import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CareerDatabase } from "../db/client.js";
import type {
  BrandProfile,
  BrandVisualBrief,
  PostDraft,
  PostDraftMediaWithMetadata
} from "../db/repositories.js";
import { createDraftService } from "../drafts/service.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import type { OpenAiFileRef } from "../media/file-download.js";
import type { MediaPostDraftVersion } from "../media/post-media-service.js";
import {
  createPrivateMediaStore,
  type StoredPrivateMedia
} from "../media/private-media-store.js";
import {
  checksumLinkedInPost,
  type LinkedInPostChecksumMedia
} from "../posts/post-checksum.js";
import type { BrandReviewProvenance } from "./brief-service.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "./profile.js";
import {
  renderBrandedCover,
  type RenderedBrandCover
} from "./renderer.js";
import { templateForMode } from "./templates.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RENDERER_VERSION = 1;

export type RenderBrandCoverInput = Readonly<{
  briefId: string;
  postId: string;
  expectedVersion: number;
  sourceImage?: OpenAiFileRef;
  altText: string;
}>;

export type BrandRenderService = Readonly<{
  render(input: RenderBrandCoverInput): Promise<{
    post: MediaPostDraftVersion;
    provenance: BrandReviewProvenance & {
      validation: RenderedBrandCover["validation"];
    };
  }>;
}>;

function validationError(field: string, reason: string): DomainError {
  return new DomainError("VALIDATION_ERROR", "Brand render input is invalid", {
    field,
    reason
  });
}

function briefNotFound(): DomainError {
  return new DomainError("NOT_FOUND", "Brand visual brief was not found", {
    entity: "brand_visual_brief"
  });
}

function postNotFound(): DomainError {
  return new DomainError("NOT_FOUND", "Brand visual brief source was not found", {
    entity: "post_draft"
  });
}

function integrityError(
  message = "Brand cover could not be saved",
  entity = "brand_visual_render"
): DomainError {
  return new DomainError("DATA_INTEGRITY", message, { entity });
}

function conflictError(): DomainError {
  return new DomainError("CONFLICT", "Brand visual brief is not ready", {
    entity: "brand_visual_brief"
  });
}

function normalizedInput(input: RenderBrandCoverInput): RenderBrandCoverInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("render", "must_be_object");
  }
  if (typeof input.briefId !== "string" || !UUID_PATTERN.test(input.briefId)) {
    throw validationError("briefId", "must_be_uuid");
  }
  if (typeof input.postId !== "string" || !UUID_PATTERN.test(input.postId)) {
    throw validationError("postId", "must_be_uuid");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError("expectedVersion", "must_be_positive_integer");
  }
  if (
    typeof input.altText !== "string"
    || [...input.altText].length < 1
    || [...input.altText].length > 120
    || input.altText.trim().length < 1
    || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(input.altText)
  ) {
    throw validationError("altText", "invalid");
  }
  return Object.freeze({
    briefId: input.briefId.toLowerCase(),
    postId: input.postId.toLowerCase(),
    expectedVersion: input.expectedVersion,
    ...(input.sourceImage === undefined
      ? {}
      : { sourceImage: Object.freeze({ ...input.sourceImage }) }),
    altText: input.altText
  });
}

function canonicalProfileMatches(
  profile: BrandProfile,
  brief: BrandVisualBrief,
  subject: string
): boolean {
  const canonical = DEFAULT_PMM_BRAND_PROFILE;
  return profile.id === brief.brandProfileId
    && profile.ownerSubject.toLowerCase() === subject
    && profile.version === brief.brandProfileVersion
    && profile.version === canonical.version
    && profile.state === "active"
    && profile.publicName === canonical.publicName
    && profile.roleLine === canonical.roleLine
    && profile.seriesName === canonical.seriesName
    && profile.monogram === canonical.monogram
    && isDeepStrictEqual(profile.voiceJson, canonical.voice)
    && isDeepStrictEqual(profile.paletteJson, canonical.palette)
    && isDeepStrictEqual(profile.hookRulesJson, canonical.hookRules);
}

function isOwnedMedia(
  item: PostDraftMediaWithMetadata,
  subject: string
): boolean {
  return item.ownerSubject.toLowerCase() === subject
    && item.objectPath.startsWith(`${subject}/`)
    && SHA256_PATTERN.test(item.sha256);
}

function isVisibility(
  value: string
): value is "PUBLIC" | "CONNECTIONS" {
  return value === "PUBLIC" || value === "CONNECTIONS";
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function validatedRender(
  value: RenderedBrandCover,
  sourceImageUsed: boolean
): RenderedBrandCover {
  const candidate = value as Partial<RenderedBrandCover> | null;
  const validation = candidate?.validation;
  if (
    candidate === null
    || !Buffer.isBuffer(candidate.bytes)
    || candidate.bytes.byteLength < 1
    || candidate.mimeType !== "image/png"
    || candidate.width !== 1080
    || candidate.height !== 1350
    || validation?.fixedLabelsPresent !== true
    || validation.textWithinSafeArea !== true
    || validation.sourceImageUsed !== sourceImageUsed
  ) {
    throw integrityError(
      "Brand cover rendering failed validation",
      "brand_renderer"
    );
  }
  return Object.freeze({
    bytes: Buffer.from(candidate.bytes),
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    validation: Object.freeze({
      fixedLabelsPresent: true,
      textWithinSafeArea: true,
      sourceImageUsed
    })
  });
}

function mapUnknownError(error: unknown): never {
  if (error instanceof DomainError) {
    throw error;
  }
  const kind = postgresErrorKind(error);
  if (kind === "unique" || kind === "retryable") {
    throw new DomainError("CONFLICT", "Brand cover could not be saved", {
      entity: "brand_visual_render"
    });
  }
  if (kind === "foreign_key") {
    throw new DomainError("NOT_FOUND", "Brand render data was not found", {
      entity: "brand_visual_render"
    });
  }
  throw integrityError();
}

export function createBrandRenderService(
  database: CareerDatabase,
  dependencies: {
    subject: string;
    privateMedia: ReturnType<typeof createPrivateMediaStore>;
    renderCover?: typeof renderBrandedCover;
  }
): BrandRenderService {
  if (
    typeof dependencies.subject !== "string"
    || !UUID_PATTERN.test(dependencies.subject)
  ) {
    throw new DomainError(
      "AUTH_REQUIRED",
      "Authenticated request identity is required"
    );
  }
  const subject = dependencies.subject.toLowerCase();
  const renderCover = dependencies.renderCover ?? renderBrandedCover;
  const drafts = createDraftService(database);

  async function exactReadySource(
    input: RenderBrandCoverInput
  ): Promise<{ brief: BrandVisualBrief; post: PostDraft }> {
    const brief = await database.brandVisualBriefs.getOwned(
      input.briefId,
      subject
    );
    if (brief === undefined) {
      throw briefNotFound();
    }

    const exact = await database.postDrafts.getVersion(
      input.postId,
      input.expectedVersion
    );
    if (
      exact === undefined
      || exact.id !== brief.postDraftId
      || exact.version !== brief.postVersion
    ) {
      throw postNotFound();
    }
    const exactMedia = await database.postDraftMedia.listForVersion(
      exact.id,
      exact.version
    );
    if (
      exactMedia.length === 0
      || exactMedia.some((item) => !isOwnedMedia(item, subject))
    ) {
      throw postNotFound();
    }

    const latest = (await database.postDrafts.listVersions(input.postId)).at(-1);
    if (latest === undefined) {
      throw postNotFound();
    }
    const latestMedia = await database.postDraftMedia.listForVersion(
      latest.id,
      latest.version
    );
    if (
      latestMedia.length === 0
      || latestMedia.some((item) => !isOwnedMedia(item, subject))
    ) {
      throw postNotFound();
    }
    if (
      latest.id !== exact.id
      || latest.version !== input.expectedVersion
    ) {
      throw new DomainError("CONFLICT", "Post draft version is stale", {
        entity: "post_draft",
        expectedVersion: input.expectedVersion,
        actualVersion: latest.version
      });
    }
    if (brief.state !== "ready") {
      throw conflictError();
    }

    const profile = await database.brandProfiles.getActive(subject);
    if (
      profile === undefined
      || !canonicalProfileMatches(profile, brief, subject)
    ) {
      throw integrityError(
        "Brand profile configuration is invalid",
        "brand_profile"
      );
    }
    if (!isVisibility(exact.visibility)) {
      throw integrityError("Stored post visibility is invalid", "post_draft");
    }
    return { brief, post: exact };
  }

  return Object.freeze({
    async render(rawInput: RenderBrandCoverInput) {
      const createdMedia: StoredPrivateMedia[] = [];
      try {
        const input = normalizedInput(rawInput);
        const { brief, post } = await exactReadySource(input);
        if (
          brief.visualMode !== "EDITORIAL_STATEMENT"
          && brief.visualMode !== "EDITORIAL_METAPHOR"
        ) {
          throw integrityError(
            "Brand template configuration is invalid",
            "brand_template"
          );
        }
        const template = templateForMode(brief.visualMode);
        if (
          brief.templateId !== template.id
          || brief.templateVersion !== template.version
          || brief.brandProfileVersion !== DEFAULT_PMM_BRAND_PROFILE.version
        ) {
          throw integrityError(
            "Brand template configuration is invalid",
            "brand_template"
          );
        }
        if (!template.requiresSourceImage && input.sourceImage !== undefined) {
          throw validationError("sourceImage", "not_allowed");
        }
        if (template.requiresSourceImage && input.sourceImage === undefined) {
          throw validationError("sourceImage", "required");
        }

        let source: StoredPrivateMedia | undefined;
        if (input.sourceImage !== undefined) {
          source = await dependencies.privateMedia.ingestOpenAiFile(
            input.sourceImage
          );
          createdMedia.push(source);
        }
        const renderInput = {
          profile: DEFAULT_PMM_BRAND_PROFILE,
          template,
          coverHook: brief.coverHook,
          ...(brief.topicLabel === null ? {} : { topicLabel: brief.topicLabel }),
          ...(source === undefined
            ? {}
            : { sourceImageBytes: Buffer.from(source.bytes) })
        };
        const rendered = validatedRender(
          await renderCover(renderInput),
          source !== undefined
        );
        const renderChecksum = createHash("sha256")
          .update(rendered.bytes)
          .digest("hex");
        const final = await dependencies.privateMedia.storeBytes(
          rendered.bytes,
          "brand-cover.png"
        );
        createdMedia.push(final);
        if (
          final.media.ownerSubject.toLowerCase() !== subject
          || !final.media.objectPath.startsWith(`${subject}/`)
          || final.media.mimeType !== "image/png"
          || final.media.width !== rendered.width
          || final.media.height !== rendered.height
          || final.media.frameCount !== 1
          || !safeTextEqual(final.media.sha256, renderChecksum)
          || !Buffer.isBuffer(final.bytes)
          || !final.bytes.equals(rendered.bytes)
          || source?.media.id.toLowerCase() === final.media.id.toLowerCase()
        ) {
          throw integrityError();
        }

        const committed = await database.brandVisualRenders.commitAndAttach({
          ownerSubject: subject,
          briefId: brief.id,
          expectedDraftId: input.postId,
          expectedVersion: input.expectedVersion,
          ...(source === undefined ? {} : { sourceMediaId: source.media.id }),
          renderedMediaId: final.media.id,
          altText: input.altText,
          renderChecksum,
          rendererVersion: RENDERER_VERSION,
          checksum: (nextVersion, logicalDraftId, media) => (
            checksumLinkedInPost({
              draftId: logicalDraftId,
              version: nextVersion,
              text: post.text,
              visibility: post.visibility as "PUBLIC" | "CONNECTIONS",
              media: media as readonly LinkedInPostChecksumMedia[]
            })
          )
        });
        const publicPost = await drafts.getPostVersion(
          committed.post.draftId,
          committed.post.version
        );
        if (
          publicPost === undefined
          || publicPost.versionId !== committed.post.id
          || publicPost.media.length !== 1
          || publicPost.media[0]?.position !== 0
          || publicPost.media[0]?.mediaId !== final.media.id
          || publicPost.media[0]?.altText !== input.altText
          || !safeTextEqual(publicPost.media[0]?.sha256 ?? "", renderChecksum)
        ) {
          throw integrityError();
        }

        return Object.freeze({
          post: publicPost as MediaPostDraftVersion,
          provenance: Object.freeze({
            seriesName: DEFAULT_PMM_BRAND_PROFILE.seriesName,
            profileVersion: brief.brandProfileVersion,
            templateId: brief.templateId,
            templateVersion: brief.templateVersion,
            coverHook: brief.coverHook,
            renderChecksum,
            validationPassed: true,
            validation: rendered.validation
          })
        });
      } catch (error) {
        await dependencies.privateMedia.removeBestEffort(createdMedia);
        mapUnknownError(error);
      }
    }
  });
}
