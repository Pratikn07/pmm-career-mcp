import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CareerDatabase } from "../db/client.js";
import type {
  BrandProfile,
  BrandVisualBrief
} from "../db/repositories.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import {
  validateBrandVisualContent,
  type BrandVisualContent
} from "./content.js";
import { normalizeTopicLabel, validateCoverHook } from "./hook.js";
import {
  DEFAULT_PMM_BRAND_PROFILE,
  type BrandVisualMode,
  type ModelSafeBrandProfile
} from "./profile.js";
import { buildSourceArtPrompt } from "./prompt.js";
import { templateForMode } from "./templates.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOPIC_LABEL_CHARACTERS = 24;
const MAX_CONCEPT_SUMMARY_CHARACTERS = 500;
const STRUCTURED_RENDER_CONSTRAINTS = Object.freeze([
  "unvalidated structured content",
  "unapproved branding",
  "source imagery"
] as const);

export type CreateBrandVisualBriefInput = Readonly<{
  postId: string;
  expectedVersion: number;
  coverHook: string;
  conceptSummary: string;
  visualMode: BrandVisualMode;
  topicLabel?: string;
  visualContent?: BrandVisualContent;
}>;

export type BrandReviewProvenance = Readonly<{
  seriesName: string;
  profileVersion: number;
  templateId: string;
  templateVersion: number;
  coverHook: string;
  renderChecksum: string;
  validationPassed: boolean;
}>;

export type BrandBriefService = Readonly<{
  getProfile(): Promise<ModelSafeBrandProfile>;
  createBrief(input: CreateBrandVisualBriefInput): Promise<{
    brief: BrandVisualBrief;
    profile: ModelSafeBrandProfile;
    requiresSourceImage: boolean;
    proposedAltText: string;
  }>;
  getProvenanceForMedia(
    mediaId: string
  ): Promise<BrandReviewProvenance | undefined>;
}>;

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "Post draft was not found", {
    entity: "post_draft"
  });
}

function validationError(
  field: string,
  reason: string,
  maximum?: number
): DomainError {
  return new DomainError("VALIDATION_ERROR", "Brand brief input is invalid", {
    field,
    reason,
    ...(maximum === undefined ? {} : { maximum })
  });
}

function validateInput(input: CreateBrandVisualBriefInput): void {
  if (
    typeof input.postId !== "string"
    || !UUID_PATTERN.test(input.postId)
  ) {
    throw validationError("postId", "must_be_uuid");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError("expectedVersion", "must_be_positive_integer");
  }
  if (
    input.visualMode !== "EDITORIAL_STATEMENT"
    && input.visualMode !== "EDITORIAL_EVIDENCE"
    && input.visualMode !== "EDITORIAL_MODEL"
    && input.visualMode !== "EDITORIAL_METAPHOR"
  ) {
    throw validationError("visualMode", "unsupported");
  }
}

function normalizedTopicLabel(topicLabel: string | undefined): string | undefined {
  if (topicLabel === undefined) {
    return undefined;
  }
  if (typeof topicLabel !== "string") {
    throw validationError(
      "topicLabel",
      "character_count",
      MAX_TOPIC_LABEL_CHARACTERS
    );
  }
  const normalized = normalizeTopicLabel(topicLabel);
  const length = [...normalized].length;
  if (length < 1 || length > MAX_TOPIC_LABEL_CHARACTERS) {
    throw validationError(
      "topicLabel",
      "character_count",
      MAX_TOPIC_LABEL_CHARACTERS
    );
  }
  return normalized;
}

function normalizedConceptSummary(conceptSummary: string): string {
  if (typeof conceptSummary !== "string") {
    throw validationError(
      "conceptSummary",
      "character_count",
      MAX_CONCEPT_SUMMARY_CHARACTERS
    );
  }
  const normalized = conceptSummary
    .normalize("NFC")
    .replace(/[\r\n\v\f\u0085\u2028\u2029]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  const length = [...normalized].length;
  if (length < 1 || length > MAX_CONCEPT_SUMMARY_CHARACTERS) {
    throw validationError(
      "conceptSummary",
      "character_count",
      MAX_CONCEPT_SUMMARY_CHARACTERS
    );
  }
  return normalized;
}

function canonicalProfileRow(profile: BrandProfile): void {
  const expected = DEFAULT_PMM_BRAND_PROFILE;
  if (
    profile.version !== expected.version
    || profile.publicName !== expected.publicName
    || profile.roleLine !== expected.roleLine
    || profile.seriesName !== expected.seriesName
    || profile.monogram !== expected.monogram
    || !isDeepStrictEqual(profile.voiceJson, expected.voice)
    || !isDeepStrictEqual(profile.paletteJson, expected.palette)
    || !isDeepStrictEqual(profile.hookRulesJson, expected.hookRules)
  ) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Brand profile configuration is invalid",
      { entity: "brand_profile" }
    );
  }
}

function profileInput(id: string, ownerSubject: string) {
  const profile = DEFAULT_PMM_BRAND_PROFILE;
  return {
    id,
    ownerSubject,
    version: profile.version,
    publicName: profile.publicName,
    roleLine: profile.roleLine,
    seriesName: profile.seriesName,
    monogram: profile.monogram,
    voiceJson: {
      persona: profile.voice.persona,
      traits: [...profile.voice.traits],
      neverInventExperience: profile.voice.neverInventExperience
    },
    paletteJson: { ...profile.palette },
    hookRulesJson: { ...profile.hookRules }
  };
}

function safePersistenceError(
  message: string,
  entity: "brand_profile" | "brand_visual_brief" | "brand_visual_render"
): DomainError {
  return new DomainError("DATA_INTEGRITY", message, { entity });
}

function mapWriteError(error: unknown): never {
  if (error instanceof DomainError) {
    throw error;
  }
  const kind = postgresErrorKind(error);
  if (kind === "unique" || kind === "retryable") {
    throw new DomainError("CONFLICT", "Brand visual brief could not be saved", {
      entity: "brand_visual_brief"
    });
  }
  if (kind === "foreign_key") {
    throw notFound();
  }
  throw safePersistenceError(
    "Brand visual brief could not be saved",
    "brand_visual_brief"
  );
}

function safeExactTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

export function createBrandBriefService(
  database: CareerDatabase,
  dependencies: {
    subject: string;
    createId?: () => string;
  }
): BrandBriefService {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError(
      "AUTH_REQUIRED",
      "Authenticated request identity is required"
    );
  }
  const subject = dependencies.subject.toLowerCase();
  const createId = dependencies.createId ?? randomUUID;

  async function recentBriefs(): Promise<BrandVisualBrief[]> {
    return database.brandVisualBriefs.listRecent(
      subject,
      DEFAULT_PMM_BRAND_PROFILE.hookRules.recentWindow
    );
  }

  async function modelSafeProfile(): Promise<ModelSafeBrandProfile> {
    const active = await database.brandProfiles.getActive(subject);
    if (active !== undefined) {
      canonicalProfileRow(active);
    }
    const recentUsage = Object.freeze((await recentBriefs()).map((brief) =>
      Object.freeze({
        templateId: brief.templateId,
        coverHook: brief.coverHook,
        createdAt: brief.createdAt
      })
    ));
    return Object.freeze({
      ...DEFAULT_PMM_BRAND_PROFILE,
      recentUsage
    });
  }

  async function exactLatestOwnedPost(
    postId: string,
    expectedVersion: number
  ) {
    const exact = await database.postDrafts.getVersion(postId, expectedVersion);
    if (exact === undefined) {
      throw notFound();
    }
    const exactMedia = await database.postDraftMedia.listForVersion(
      exact.id,
      exact.version
    );
    if (exactMedia.some(
      ({ ownerSubject }) => ownerSubject.toLowerCase() !== subject
    )) {
      throw notFound();
    }

    const latest = (await database.postDrafts.listVersions(postId)).at(-1);
    if (latest === undefined) {
      throw notFound();
    }
    const latestMedia = await database.postDraftMedia.listForVersion(
      latest.id,
      latest.version
    );
    if (latestMedia.some(
      ({ ownerSubject }) => ownerSubject.toLowerCase() !== subject
    )) {
      throw notFound();
    }
    if (latest.id !== exact.id || latest.version !== expectedVersion) {
      throw new DomainError("CONFLICT", "Post draft version is stale", {
        entity: "post_draft",
        expectedVersion,
        actualVersion: latest.version
      });
    }
    return exact;
  }

  return Object.freeze({
    async getProfile(): Promise<ModelSafeBrandProfile> {
      try {
        return await modelSafeProfile();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw safePersistenceError(
          "Brand profile could not be loaded",
          "brand_profile"
        );
      }
    },

    async createBrief(input: CreateBrandVisualBriefInput) {
      try {
        validateInput(input);
        const topicLabel = normalizedTopicLabel(input.topicLabel);
        const conceptSummary = normalizedConceptSummary(input.conceptSummary);
        const visualContent = validateBrandVisualContent(
          input.visualMode,
          input.visualContent
        );
        const post = await exactLatestOwnedPost(input.postId, input.expectedVersion);
        const coverHook = validateCoverHook(post.text, input.coverHook);
        const recent = await recentBriefs();
        if (recent.some((brief) => brief.coverHook === coverHook)) {
          throw new DomainError(
            "VALIDATION_ERROR",
            "Cover hook does not meet the brand rules.",
            { field: "coverHook", reason: "recent_duplicate" }
          );
        }
        const template = templateForMode(input.visualMode);
        const prompt = visualContent === undefined
          ? buildSourceArtPrompt(
              DEFAULT_PMM_BRAND_PROFILE,
              template,
              conceptSummary
            )
          : Object.freeze({
              formatVersion: 1 as const,
              generationPrompt:
                "Render the validated structured editorial content deterministically with the selected brand template.",
              negativeConstraints: STRUCTURED_RENDER_CONSTRAINTS
            });
        const proposedAltText = input.visualMode === "EDITORIAL_MODEL"
          ? `Editorial Product Marketing model titled “${coverHook}”.`
          : input.visualMode === "EDITORIAL_EVIDENCE"
            ? `Editorial Product Marketing evidence card titled “${coverHook}”.`
            : `Editorial Product Marketing cover titled “${coverHook}”.`;
        if ([...proposedAltText].length > 120) {
          throw safePersistenceError(
            "Brand visual brief alt text could not be prepared",
            "brand_visual_brief"
          );
        }
        const profileId = createId();
        if (!UUID_PATTERN.test(profileId)) {
          throw safePersistenceError(
            "Brand profile could not be initialized",
            "brand_profile"
          );
        }
        const briefId = createId();
        if (!UUID_PATTERN.test(briefId)) {
          throw safePersistenceError(
            "Brand visual brief could not be saved",
            "brand_visual_brief"
          );
        }
        const { profile, brief } =
          await database.brandVisualBriefs.createWithDefaultProfile({
            profile: profileInput(profileId, subject),
            brief: {
              id: briefId,
              ownerSubject: subject,
              postDraftId: post.id,
              postVersion: post.version,
              templateId: template.id,
              templateVersion: template.version,
              promptFormatVersion: prompt.formatVersion,
              visualMode: template.mode,
              coverHook,
              conceptSummary,
              ...(topicLabel === undefined ? {} : { topicLabel }),
              generationPrompt: prompt.generationPrompt,
              negativeConstraintsJson: [...prompt.negativeConstraints],
              ...(visualContent === undefined
                ? {}
                : { visualContentJson: visualContent }),
              state: "ready"
            }
          });
        canonicalProfileRow(profile);
        return {
          brief,
          profile: await modelSafeProfile(),
          requiresSourceImage: template.requiresSourceImage,
          proposedAltText
        };
      } catch (error) {
        mapWriteError(error);
      }
    },

    async getProvenanceForMedia(
      mediaId: string
    ): Promise<BrandReviewProvenance | undefined> {
      if (typeof mediaId !== "string" || !UUID_PATTERN.test(mediaId)) {
        return undefined;
      }
      try {
        const provenance = await database.brandVisualRenders.getByRenderedMedia(
          subject,
          mediaId
        );
        if (provenance === undefined) {
          return undefined;
        }
        canonicalProfileRow(provenance.profile);
        return Object.freeze({
          seriesName: DEFAULT_PMM_BRAND_PROFILE.seriesName,
          profileVersion: provenance.brief.brandProfileVersion,
          templateId: provenance.brief.templateId,
          templateVersion: provenance.brief.templateVersion,
          coverHook: provenance.brief.coverHook,
          renderChecksum: provenance.renderChecksum,
          validationPassed: safeExactTextEqual(
            provenance.renderChecksum,
            provenance.renderedMediaSha256
          )
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw safePersistenceError(
          "Brand render provenance could not be loaded",
          "brand_visual_render"
        );
      }
    }
  });
}
