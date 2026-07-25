import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  brandBriefSourceClaims,
  brandProfiles,
  brandVisualBriefs,
  brandVisualRenders,
  companies,
  evidence,
  founderExportDownloadCapabilities,
  founderProfileCandidates,
  founderProfileConfirmationEvents,
  founderResearchExports,
  founderResearchRunItems,
  founderResearchRunPeople,
  founderResearchRuns,
  mediaUsageClaims,
  oauthTokens,
  outreachDrafts,
  people,
  postDraftMedia,
  postDraftOwners,
  postDrafts,
  postMedia,
  postPreviews,
  publishAttemptMedia,
  publishAttempts,
  schema,
  settings,
  shortlistEntries,
  shortlists,
  targetNotes,
  targets
} from "./schema.js";
import { DomainError } from "../domain/errors.js";
import { checksumLinkedInPost } from "../posts/post-checksum.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Setting = typeof settings.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type TargetNote = typeof targetNotes.$inferSelect;
export type OutreachDraftRow = typeof outreachDrafts.$inferSelect;
export type OutreachDraft = Omit<OutreachDraftRow, "evidenceIdsJson"> & { evidenceIds: string[] };
export type Shortlist = typeof shortlists.$inferSelect;
export type ShortlistEntry = typeof shortlistEntries.$inferSelect;
export type ShortlistWithEntries = Shortlist & { entries: ShortlistEntry[] };
export type PostMedia = typeof postMedia.$inferSelect;
export type PostDraft = typeof postDrafts.$inferSelect;
export type PostDraftMedia = typeof postDraftMedia.$inferSelect;
export type PostDraftMediaWithMetadata = PostDraftMedia & Omit<PostMedia, "id">;
export type PostPreview = typeof postPreviews.$inferSelect;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
export type PublishAttemptMedia = typeof publishAttemptMedia.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type BrandProfile = typeof brandProfiles.$inferSelect;
export type BrandVisualBrief = typeof brandVisualBriefs.$inferSelect;
export type BrandVisualRender = typeof brandVisualRenders.$inferSelect;
export type PersonWithEvidence = Person & { evidence: Evidence[] };
export type FounderResearchRun = typeof founderResearchRuns.$inferSelect;
export type FounderResearchRunItem = typeof founderResearchRunItems.$inferSelect;
export type FounderResearchRunPerson = typeof founderResearchRunPeople.$inferSelect;
export type FounderProfileCandidate = typeof founderProfileCandidates.$inferSelect;
export type FounderProfileConfirmationEvent =
  typeof founderProfileConfirmationEvents.$inferSelect;
export type FounderResearchExport = typeof founderResearchExports.$inferSelect;
export type FounderExportCapability =
  typeof founderExportDownloadCapabilities.$inferSelect;

export type FounderResearchRunCreateInput = Readonly<{
  ownerSubject: string;
  queryJson: Record<string, unknown>;
  requestedLimit: number;
  companyIds: readonly string[];
}>;

export type FounderResearchLeaseInput = Readonly<{
  runId: string;
  ownerSubject: string;
  maxItems: number;
  leasedAt: string;
  leaseExpiresAt: string;
}>;

export type FounderResearchCompleteItemInput = Readonly<{
  itemId: string;
  ownerSubject: string;
  leaseAttempt: number;
  state: "COMPLETE" | "PARTIAL" | "NOT_FOUND" | "AMBIGUOUS" | "NEEDS_PUBLIC_SEARCH";
  checkedAt: string;
}>;

export type FounderResearchFailItemInput = Readonly<{
  itemId: string;
  ownerSubject: string;
  leaseAttempt: number;
  checkedAt: string;
  errorCode: string;
  errorSummary: string;
  errorDetailJson?: Record<string, unknown>;
}>;

export type FounderResearchPersonSaveInput = Readonly<{
  runItemId: string;
  ownerSubject: string;
  personId: string;
  founderRoleMatch: string;
  confidence: number;
}>;

type FounderProfileCandidateEvidenceInput = Readonly<{
  runPersonId: string;
  ownerSubject: string;
  profileUrl: string;
  evidenceUrl: string;
  evidenceTitle?: string;
  evidenceSnippet?: string;
  evidenceMetadataJson: Record<string, unknown>;
  checkedAt: string;
  confidence: number;
}>;

export type FounderProfileCandidateSaveInput = FounderProfileCandidateEvidenceInput & Readonly<{
  searchQuery: string;
}>;

export type FounderProfileOfficialInput = FounderProfileCandidateEvidenceInput & Readonly<{
  sourceKind: "OFFICIAL_YC" | "OFFICIAL_COMPANY";
}>;

export type FounderProfileDecisionInput = Readonly<{
  candidateId: string;
  ownerSubject: string;
  note?: string;
  decidedAt: string;
}>;

export type FounderResearchExportCreateInput = Readonly<{
  runId: string;
  ownerSubject: string;
  fileName: string;
  mimeType: string;
  checksumSha256: string;
  workbookBytes: Buffer | Uint8Array;
  rowCount: number;
  sheetCount: number;
  createdAt: string;
  expiresAt: string;
}>;

export type FounderExportCapabilityCreateInput = Readonly<{
  exportId: string;
  ownerSubject: string;
  tokenHashSha256: string;
  createdAt: string;
  expiresAt: string;
}>;

export type UsableFounderExportCapability = Readonly<{
  capability: FounderExportCapability;
  export: FounderResearchExport;
}>;

export type BrandProfileDefaultInput = {
  id: string;
  ownerSubject: string;
  publicName: string;
  roleLine: string;
  seriesName: string;
  monogram: string;
  voiceJson: Record<string, unknown>;
  paletteJson: Record<string, string>;
  hookRulesJson: Record<string, unknown>;
};

export type BrandVisualBriefCreateInput =
  Omit<typeof brandVisualBriefs.$inferInsert, "createdAt">;

export type BrandVisualBriefWithDefaultProfileInput = {
  profile: BrandProfileDefaultInput;
  brief: Omit<
    BrandVisualBriefCreateInput,
    "brandProfileId" | "brandProfileVersion"
  >;
};

export type BrandVisualRenderCommitInput = Readonly<{
  ownerSubject: string;
  briefId: string;
  expectedDraftId: string;
  expectedVersion: number;
  sourceMediaId?: string;
  renderedMediaId: string;
  altText: string;
  renderChecksum: string;
  rendererVersion: number;
  checksum: (
    nextVersion: number,
    logicalDraftId: string,
    media: readonly {
      position: number;
      sha256: string;
      mimeType: string;
      altText: string;
    }[]
  ) => string;
}>;

export type CompanyUpsertInput = {
  ycId: string;
  name: string;
  batch?: string;
  status?: string;
  websiteUrl?: string;
  ycUrl?: string;
  location?: string;
  industry?: string;
  isHiring?: boolean;
  checkedAt?: string;
};

export type PersonUpsertInput = {
  companyId: string;
  name: string;
  role: string;
  publicProfileUrl?: string;
  checkedAt?: string;
};

export type EvidenceAddInput = {
  personId: string;
  sourceUrl: string;
  title?: string;
  factType?: string;
  fact: string;
  checkedAt: string;
  confidence: number;
};

export type CompanyPersonDiscoveryRefreshInput = {
  companyId: string;
  replaceMissingDiscovery?: boolean;
  people: Array<{
    name: string;
    role: string;
    publicProfileUrl?: string;
    checkedAt: string;
    evidence: Array<Omit<EvidenceAddInput, "personId">>;
  }>;
};

export type TargetUpsertInput = {
  personId: string;
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
  totalScore: number;
  confidence: number;
  rationale: string;
};

export type TargetListFilter = {
  companyId?: string;
  status?: string;
};

export type OutreachDraftVersionInput = {
  targetId: string;
  purpose: string;
  text: string;
  evidenceIds: string[];
};

export type PostDraftVersionInput = {
  draftId?: string;
  ownerSubject: string;
  text: string;
  visibility: string;
  checksum: string | ((version: number) => string);
  state: string;
};

export type PostMediaCreateInput = Omit<typeof postMedia.$inferInsert, "createdAt"> & {
  createdAt?: string;
};

export type PostDraftVersionWithMediaInput = Omit<PostDraftVersionInput, "checksum"> & {
  expectedVersion?: number;
  media: readonly { mediaId: string; altText: string }[];
  checksum: string | ((
    version: number,
    draftId: string,
    media: readonly {
      position: number;
      sha256: string;
      mimeType: string;
      altText: string;
    }[]
  ) => string);
};

export class PostDraftVersionConflictError extends Error {
  constructor() {
    super("Post draft version is stale");
    this.name = "PostDraftVersionConflictError";
  }
}

export type PublishAttemptMediaUpdateInput = {
  id: string;
  expectedState?: string;
  state: string;
  linkedinImageUrn?: string | null;
};

export type PreviewExpectedRow = {
  postId: string;
  versionId: string;
  version: number;
  checksum: string;
  visibility: string;
};

export type PreviewCreationResult =
  | { outcome: "created"; post: PostDraft; preview: PostPreview }
  | {
      outcome:
        | "not_found"
        | "not_latest"
        | "invalid_state"
        | "integrity_mismatch";
    };

export type ExactPreviewSnapshotExpected = Readonly<{
  subject: string;
  post: Readonly<Pick<
    PostDraft,
    "id" | "draftId" | "text" | "visibility" | "version" | "checksum"
  >>;
  media: readonly Readonly<PostDraftMediaWithMetadata>[];
}>;

export type PreviewConsumptionResult =
  | { outcome: "consumed"; post: PostDraft; preview: PostPreview }
  | {
      outcome:
        | "not_found"
        | "already_consumed"
        | "expired"
        | "mismatch"
        | "stale"
        | "invalid_state"
        | "race";
    };

export type PreviewConsumptionInput = {
  tokenHash: string;
  consumedAt: string;
  expected: PreviewExpectedRow;
  allowedStates: readonly string[];
  claimState?: string;
};

export type PublishAttemptRecordInput = Omit<typeof publishAttempts.$inferInsert, "id">;

export type PublishClaimRecordResult =
  | {
      outcome: "recorded";
      post: PostDraft;
      preview: PostPreview;
      attempt: PublishAttempt;
    }
  | Exclude<PreviewConsumptionResult, { outcome: "consumed" }>;

export type ExactPublishSnapshotMedia = PostDraftMediaWithMetadata;

export type ExactPublishClaimResult =
  | {
      outcome: "recorded";
      post: PostDraft;
      preview: PostPreview;
      attempt: PublishAttempt;
      attemptMedia: PublishAttemptMedia[];
      media: ExactPublishSnapshotMedia[];
    }
  | {
      outcome:
        | "not_found"
        | "already_consumed"
        | "expired"
        | "stale"
        | "invalid_state"
        | "wrong_owner"
        | "image_disabled"
        | "integrity_mismatch"
        | "race";
    };

const SERIALIZABLE_RETRY_DELAYS_MS = Object.freeze([5, 15]);

function postgresErrorField(error: unknown, field: "code" | "constraint_name"): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (field in current && typeof (current as Record<string, unknown>)[field] === "string") {
      return (current as Record<string, string>)[field];
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function isRetryableTransactionError(
  error: unknown,
  uniqueConstraints?: string | readonly string[]
): boolean {
  const code = postgresErrorField(error, "code");
  if (code === "40001" || code === "40P01") {
    return true;
  }
  const allowedConstraints = uniqueConstraints === undefined
    ? []
    : typeof uniqueConstraints === "string"
      ? [uniqueConstraints]
      : uniqueConstraints;
  return code === "23505"
    && allowedConstraints.includes(postgresErrorField(error, "constraint_name") ?? "");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function serializableTransaction<T>(
  database: Database,
  operation: (transaction: Database) => Promise<T>,
  uniqueConstraints?: string | readonly string[]
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.transaction(operation, {
        isolationLevel: "serializable",
        accessMode: "read write"
      });
    } catch (error) {
      const retryDelay = SERIALIZABLE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isRetryableTransactionError(error, uniqueConstraints)) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertIsoTimestamp(field: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp in YYYY-MM-DDTHH:mm:ss.sssZ format`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function normalizeRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  const normalized: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(normalized)) {
    if (key.endsWith("At") && value !== null && value !== undefined) {
      const parsed = value instanceof Date ? value : new Date(String(value));
      normalized[key] = parsed.toISOString();
    }
  }
  return normalized as T;
}

function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(normalizeRowTimestamps);
}

function requiredRow<T extends Record<string, unknown>>(row: T | undefined, entity: string): T {
  if (row === undefined) {
    throw new Error(`${entity} write did not return a row`);
  }
  return normalizeRowTimestamps(row);
}

function decodeOutreachDraft(row: OutreachDraftRow): OutreachDraft {
  const { evidenceIdsJson, ...draft } = normalizeRowTimestamps(row);
  return { ...draft, evidenceIds: [...evidenceIdsJson] };
}

function normalizedPersonIdentity(name: string, role: string): string {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  return `${normalize(name)}\u0000${normalize(role)}`;
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isExactPreviewMimeType(
  value: string
): value is "image/jpeg" | "image/png" | "image/gif" {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif";
}

function exactPreviewSnapshotMatches(
  post: PostDraft,
  media: readonly PostDraftMediaWithMetadata[],
  expected: ExactPreviewSnapshotExpected
): boolean {
  if (
    !isUuid(expected.subject)
    || post.id !== expected.post.id
    || post.draftId !== expected.post.draftId
    || post.text !== expected.post.text
    || post.visibility !== expected.post.visibility
    || post.version !== expected.post.version
    || post.checksum !== expected.post.checksum
    || media.length !== expected.media.length
    || media.length > 4
    || (post.visibility !== "PUBLIC" && post.visibility !== "CONNECTIONS")
  ) {
    return false;
  }

  const subject = expected.subject.toLowerCase();
  for (let position = 0; position < media.length; position += 1) {
    const current = media[position]!;
    const signed = expected.media[position]!;
    if (
      current.postDraftId !== post.id
      || current.version !== post.version
      || current.position !== position
      || current.ownerSubject.toLowerCase() !== subject
      || !current.objectPath.startsWith(`${subject}/`)
      || current.postDraftId !== signed.postDraftId
      || current.version !== signed.version
      || current.position !== signed.position
      || current.mediaId !== signed.mediaId
      || current.altText !== signed.altText
      || current.ownerSubject !== signed.ownerSubject
      || current.objectPath !== signed.objectPath
      || current.sha256 !== signed.sha256
      || current.mimeType !== signed.mimeType
      || current.byteSize !== signed.byteSize
      || current.width !== signed.width
      || current.height !== signed.height
      || current.frameCount !== signed.frameCount
      || current.originalFilename !== signed.originalFilename
      || current.createdAt !== signed.createdAt
      || !isExactPreviewMimeType(current.mimeType)
    ) {
      return false;
    }
  }

  try {
    const recomputed = checksumLinkedInPost({
      draftId: post.draftId,
      version: post.version,
      text: post.text,
      visibility: post.visibility,
      media: media.map(({ position, sha256, mimeType, altText }) => {
        if (!isExactPreviewMimeType(mimeType)) {
          throw new TypeError("Stored exact-preview media type is invalid");
        }
        return { position, sha256, mimeType, altText };
      })
    });
    return timingSafeTextEqual(recomputed, post.checksum)
      && timingSafeTextEqual(recomputed, expected.post.checksum);
  } catch {
    return false;
  }
}

const FOUNDER_RESEARCH_TERMINAL_STATES = new Set([
  "COMPLETE",
  "PARTIAL",
  "NOT_FOUND",
  "AMBIGUOUS",
  "FAILED"
]);

function founderProfileStatusRank(status: string): number {
  switch (status) {
    case "CONFIRMED":
      return 3;
    case "VERIFIED":
      return 2;
    case "CANDIDATE":
      return 1;
    default:
      return 0;
  }
}

function normalizeOwnerSubject(ownerSubject: string): string {
  if (!isUuid(ownerSubject)) {
    throw new Error("ownerSubject must be a UUID");
  }
  return ownerSubject.toLowerCase();
}

async function recomputeFounderResearchRun(
  transaction: Database,
  runId: string,
  ownerSubject: string,
  recomputedAt = nowIso()
): Promise<FounderResearchRun | undefined> {
  const [runRow] = await transaction.select().from(founderResearchRuns).where(and(
    eq(founderResearchRuns.id, runId),
    eq(founderResearchRuns.ownerSubject, ownerSubject)
  )).limit(1).for("update");
  if (runRow === undefined) {
    return undefined;
  }

  const items = await transaction.select({
    state: founderResearchRunItems.state,
    updatedAt: founderResearchRunItems.updatedAt
  }).from(founderResearchRunItems).where(and(
    eq(founderResearchRunItems.runId, runId),
    eq(founderResearchRunItems.ownerSubject, ownerSubject)
  ));
  const count = (state: string) => items.filter((item) => item.state === state).length;
  const selectedCount = items.length;
  const completeCount = count("COMPLETE");
  const partialCount = count("PARTIAL");
  const ambiguousCount = count("AMBIGUOUS");
  const notFoundCount = count("NOT_FOUND");
  const failedCount = count("FAILED");
  const processedCount = items.filter((item) => (
    FOUNDER_RESEARCH_TERMINAL_STATES.has(item.state)
  )).length;
  const needsPublicSearch = count("NEEDS_PUBLIC_SEARCH");
  const leased = count("LEASED");
  const pending = count("PENDING");
  const effectiveRecomputedAt = [
    recomputedAt,
    normalizeRowTimestamps(runRow).createdAt,
    normalizeRowTimestamps(runRow).startedAt,
    ...normalizeRows(items).map(({ updatedAt }) => updatedAt)
  ].filter((value): value is string => value !== null).sort().at(-1) ?? recomputedAt;

  let state = runRow.state;
  let completedAt: string | null = null;
  if (selectedCount > 0 && processedCount === selectedCount) {
    state = failedCount === selectedCount
      ? "FAILED"
      : completeCount === selectedCount
        ? "COMPLETE"
        : "PARTIAL";
    completedAt = normalizeRowTimestamps(runRow).completedAt ?? effectiveRecomputedAt;
  } else if (needsPublicSearch > 0 && pending === 0 && leased === 0) {
    state = "NEEDS_PUBLIC_SEARCH";
  } else if (leased > 0 || processedCount > 0 || needsPublicSearch > 0) {
    state = "RUNNING";
  } else {
    state = "PENDING";
  }

  const [updated] = await transaction.update(founderResearchRuns).set({
    state,
    selectedCount,
    processedCount,
    completeCount,
    partialCount,
    ambiguousCount,
    notFoundCount,
    failedCount,
    completedAt,
    updatedAt: effectiveRecomputedAt
  }).where(and(
    eq(founderResearchRuns.id, runId),
    eq(founderResearchRuns.ownerSubject, ownerSubject)
  )).returning();
  return updated === undefined ? undefined : normalizeRowTimestamps(updated);
}

type BrandBriefSourceInput = Pick<
  BrandVisualBriefCreateInput,
  "ownerSubject" | "postDraftId" | "postVersion" | "coverHook"
>;

function brandBriefSourceNotFound(): DomainError {
  return new DomainError("NOT_FOUND", "Brand visual brief source was not found", {
    entity: "post_draft"
  });
}

function brandRenderIntegrityError(): DomainError {
  return new DomainError("DATA_INTEGRITY", "Brand render data is invalid", {
    entity: "brand_visual_render"
  });
}

async function rejectBrandSourceMediaAttachments(
  transaction: Database,
  mediaIds: readonly string[]
): Promise<void> {
  if (mediaIds.length === 0) {
    return;
  }
  const [reservedClaim] = await transaction.select({
    purpose: mediaUsageClaims.purpose
  }).from(mediaUsageClaims).where(and(
    inArray(mediaUsageClaims.mediaId, [...mediaIds]),
    eq(mediaUsageClaims.purpose, "brand_source")
  )).limit(1);
  const reserved = await transaction.select({
    sourceMediaId: brandVisualRenders.sourceMediaId
  }).from(brandVisualRenders).where(
    inArray(brandVisualRenders.sourceMediaId, [...mediaIds])
  ).limit(1);
  if (reservedClaim !== undefined || reserved.length > 0) {
    throw brandRenderIntegrityError();
  }
}

async function validateOwnedBrandPostMedia(
  transaction: Database,
  input: Readonly<{
    postDraftId: string;
    version: number;
    ownerSubject: string;
  }>
): Promise<void> {
  const draftMedia = await transaction.select({
    mediaId: postDraftMedia.mediaId
  }).from(postDraftMedia).where(and(
    eq(postDraftMedia.postDraftId, input.postDraftId),
    eq(postDraftMedia.version, input.version)
  )).orderBy(asc(postDraftMedia.position));
  if (draftMedia.length === 0) {
    return;
  }

  const mediaIds = draftMedia.map(({ mediaId }) => mediaId.toLowerCase()).sort();
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw brandBriefSourceNotFound();
  }
  const media = await transaction.select({
    id: postMedia.id,
    ownerSubject: postMedia.ownerSubject,
    objectPath: postMedia.objectPath,
    sha256: postMedia.sha256
  }).from(postMedia).where(
    inArray(postMedia.id, mediaIds)
  ).orderBy(asc(postMedia.id));
  if (
    media.length !== mediaIds.length
    || media.some((row) => (
      row.ownerSubject.toLowerCase() !== input.ownerSubject.toLowerCase()
      || !row.objectPath.startsWith(`${input.ownerSubject.toLowerCase()}/`)
      || !SHA256_PATTERN.test(row.sha256)
    ))
  ) {
    throw brandBriefSourceNotFound();
  }
}

async function lockBrandBriefMediaOwners(
  transaction: Database,
  postDraftId: string,
  version: number
): Promise<string[] | undefined> {
  const draftMedia = await transaction.select({
    mediaId: postDraftMedia.mediaId
  }).from(postDraftMedia).where(and(
    eq(postDraftMedia.postDraftId, postDraftId),
    eq(postDraftMedia.version, version)
  )).orderBy(asc(postDraftMedia.position)).for("update");
  if (draftMedia.length === 0) {
    return [];
  }
  const sortedMediaIds = draftMedia
    .map(({ mediaId }) => mediaId.toLowerCase())
    .sort();
  if (new Set(sortedMediaIds).size !== sortedMediaIds.length) {
    return undefined;
  }
  const media = await transaction.select({
    id: postMedia.id,
    ownerSubject: postMedia.ownerSubject
  }).from(postMedia).where(
    inArray(postMedia.id, sortedMediaIds)
  ).orderBy(asc(postMedia.id)).for("update");
  if (media.length !== sortedMediaIds.length) {
    return undefined;
  }
  return media.map(({ ownerSubject }) => ownerSubject);
}

async function lockLatestOwnedBrandBriefSource(
  transaction: Database,
  input: BrandBriefSourceInput
): Promise<void> {
  const [reference] = await transaction.select({
    draftId: postDrafts.draftId
  }).from(postDrafts).where(and(
    eq(postDrafts.id, input.postDraftId),
    eq(postDrafts.version, input.postVersion)
  )).limit(1);
  if (reference === undefined) {
    throw brandBriefSourceNotFound();
  }

  const [latest] = await transaction.select({
    id: postDrafts.id,
    version: postDrafts.version
  }).from(postDrafts).where(
    eq(postDrafts.draftId, reference.draftId)
  ).orderBy(desc(postDrafts.version)).limit(1).for("update");
  if (latest === undefined) {
    throw brandBriefSourceNotFound();
  }

  const [exact] = await transaction.select({
    id: postDrafts.id
  }).from(postDrafts).where(and(
    eq(postDrafts.id, input.postDraftId),
    eq(postDrafts.version, input.postVersion)
  )).limit(1).for("update");
  if (exact === undefined) {
    throw brandBriefSourceNotFound();
  }
  const [ownership] = await transaction.select({
    draftId: postDraftOwners.draftId
  }).from(postDraftOwners).where(and(
    eq(postDraftOwners.draftId, reference.draftId),
    eq(postDraftOwners.ownerSubject, input.ownerSubject.toLowerCase())
  )).limit(1);
  if (ownership === undefined) {
    throw brandBriefSourceNotFound();
  }
  const sourceMediaOwners = await lockBrandBriefMediaOwners(
    transaction,
    input.postDraftId,
    input.postVersion
  );
  if (
    sourceMediaOwners === undefined
    || sourceMediaOwners.some((ownerSubject) => (
      ownerSubject.toLowerCase() !== input.ownerSubject.toLowerCase()
    ))
  ) {
    throw brandBriefSourceNotFound();
  }

  const latestMediaOwners = latest.id === input.postDraftId
    ? sourceMediaOwners
    : await lockBrandBriefMediaOwners(transaction, latest.id, latest.version);
  if (
    latestMediaOwners === undefined
    || latestMediaOwners.some((ownerSubject) => (
      ownerSubject.toLowerCase() !== input.ownerSubject.toLowerCase()
    ))
  ) {
    throw brandBriefSourceNotFound();
  }

  if (latest.id !== input.postDraftId || latest.version !== input.postVersion) {
    throw new DomainError("CONFLICT", "Post draft version is stale", {
      entity: "post_draft",
      expectedVersion: input.postVersion,
      actualVersion: latest.version
    });
  }
}

async function rejectRecentBrandHook(
  transaction: Database,
  input: Pick<BrandVisualBriefCreateInput, "ownerSubject" | "coverHook">
): Promise<void> {
  const recentHooks = await transaction.select({
    coverHook: brandVisualBriefs.coverHook
  }).from(brandVisualBriefs).where(
    eq(brandVisualBriefs.ownerSubject, input.ownerSubject)
  ).orderBy(
    desc(brandVisualBriefs.createdAt),
    desc(brandVisualBriefs.id)
  ).limit(30).for("update");
  if (recentHooks.some(({ coverHook }) => coverHook === input.coverHook)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Cover hook does not meet the brand rules.",
      { field: "coverHook", reason: "recent_duplicate" }
    );
  }
}

function profileMatchesDefaultInput(
  profile: BrandProfile,
  input: BrandProfileDefaultInput
): boolean {
  return profile.version === 1
    && profile.publicName === input.publicName
    && profile.roleLine === input.roleLine
    && profile.seriesName === input.seriesName
    && profile.monogram === input.monogram
    && isDeepStrictEqual(profile.voiceJson, input.voiceJson)
    && isDeepStrictEqual(profile.paletteJson, input.paletteJson)
    && isDeepStrictEqual(profile.hookRulesJson, input.hookRulesJson);
}

async function insertBrandVisualBrief(
  transaction: Database,
  input: BrandVisualBriefCreateInput
): Promise<BrandVisualBrief> {
  const [brief] = await transaction.insert(brandVisualBriefs).values({
    ...input,
    createdAt: nowIso()
  }).returning();
  return requiredRow(brief, "brand visual brief");
}

async function upsertFounderProfileCandidate(
  transaction: Database,
  input: FounderProfileCandidateEvidenceInput & Readonly<{
    searchQuery?: string;
    sourceKind: "OFFICIAL_YC" | "OFFICIAL_COMPANY" | "PUBLIC_SEARCH";
    status: "VERIFIED" | "CANDIDATE";
  }>
): Promise<FounderProfileCandidate> {
  const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
  const checkedAt = assertIsoTimestamp("founderProfileCandidate.checkedAt", input.checkedAt);
  const [existingRow] = await transaction.select().from(founderProfileCandidates).where(and(
    eq(founderProfileCandidates.ownerSubject, ownerSubject),
    eq(founderProfileCandidates.runPersonId, input.runPersonId),
    eq(founderProfileCandidates.profileUrl, input.profileUrl)
  )).limit(1).for("update");
  if (existingRow === undefined) {
    const [inserted] = await transaction.insert(founderProfileCandidates).values({
      id: randomUUID(),
      runPersonId: input.runPersonId,
      ownerSubject,
      profileUrl: input.profileUrl,
      status: input.status,
      sourceKind: input.sourceKind,
      searchQuery: input.searchQuery ?? null,
      evidenceUrl: input.evidenceUrl,
      evidenceTitle: input.evidenceTitle ?? null,
      evidenceSnippet: input.evidenceSnippet ?? null,
      evidenceMetadataJson: input.evidenceMetadataJson,
      checkedAt,
      confidence: input.confidence,
      createdAt: checkedAt,
      updatedAt: checkedAt
    }).returning();
    return requiredRow(inserted, "founder profile candidate");
  }

  const existing = normalizeRowTimestamps(existingRow);
  if (
    founderProfileStatusRank(existing.status) > founderProfileStatusRank(input.status)
    || (existing.status === "REJECTED" && input.status === "CANDIDATE")
  ) {
    return existing;
  }
  const [updated] = await transaction.update(founderProfileCandidates).set({
    status: input.status,
    sourceKind: input.sourceKind,
    searchQuery: input.searchQuery ?? null,
    evidenceUrl: input.evidenceUrl,
    evidenceTitle: input.evidenceTitle ?? null,
    evidenceSnippet: input.evidenceSnippet ?? null,
    evidenceMetadataJson: input.evidenceMetadataJson,
    checkedAt,
    confidence: input.confidence,
    updatedAt: checkedAt
  }).where(and(
    eq(founderProfileCandidates.id, existing.id),
    eq(founderProfileCandidates.ownerSubject, ownerSubject)
  )).returning();
  return requiredRow(updated, "founder profile candidate");
}

async function decideFounderProfileCandidate(
  transaction: Database,
  input: FounderProfileDecisionInput,
  decision: "CONFIRMED" | "REJECTED"
): Promise<FounderProfileCandidate | undefined> {
  const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
  const decidedAt = assertIsoTimestamp("founderProfileCandidate.decidedAt", input.decidedAt);
  const [candidateRow] = await transaction.select().from(founderProfileCandidates).where(and(
    eq(founderProfileCandidates.id, input.candidateId),
    eq(founderProfileCandidates.ownerSubject, ownerSubject)
  )).limit(1).for("update");
  if (candidateRow === undefined) {
    return undefined;
  }
  const candidate = normalizeRowTimestamps(candidateRow);
  if (candidate.status === decision) {
    return candidate;
  }
  if (candidate.status === "CONFIRMED" || candidate.status === "REJECTED") {
    throw new DomainError("INVALID_TRANSITION", "Founder profile decision is stale", {
      entity: "founder_profile_candidate"
    });
  }

  const [updatedRow] = await transaction.update(founderProfileCandidates).set({
    status: decision,
    updatedAt: decidedAt
  }).where(and(
    eq(founderProfileCandidates.id, candidate.id),
    eq(founderProfileCandidates.ownerSubject, ownerSubject),
    eq(founderProfileCandidates.status, candidate.status)
  )).returning();
  if (updatedRow === undefined) {
    throw new DomainError("CONFLICT", "Founder profile decision raced", {
      entity: "founder_profile_candidate"
    });
  }
  const updated = normalizeRowTimestamps(updatedRow);
  const [eventRow] = await transaction.insert(founderProfileConfirmationEvents).values({
    id: randomUUID(),
    candidateId: updated.id,
    ownerSubject,
    event: decision,
    note: input.note ?? null,
    createdAt: decidedAt
  }).returning();
  requiredRow(eventRow, "founder profile confirmation event");

  if (decision === "CONFIRMED") {
    const [runPerson] = await transaction.update(founderResearchRunPeople).set({
      identityStatus: "CONFIRMED",
      updatedAt: decidedAt
    }).where(and(
      eq(founderResearchRunPeople.id, updated.runPersonId),
      eq(founderResearchRunPeople.ownerSubject, ownerSubject)
    )).returning({
      personId: founderResearchRunPeople.personId
    });
    if (runPerson === undefined) {
      throw new DomainError("DATA_INTEGRITY", "Founder research person was not found", {
        entity: "founder_research_person"
      });
    }
    await transaction.update(people).set({
      publicProfileUrl: updated.profileUrl,
      checkedAt: decidedAt,
      updatedAt: decidedAt
    }).where(eq(people.id, runPerson.personId));
  }
  return updated;
}

export function createRepositories(database: Database) {
  function postDraftMediaForVersionQuery(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ) {
    return queryDatabase.select({
      postDraftId: postDraftMedia.postDraftId,
      version: postDraftMedia.version,
      position: postDraftMedia.position,
      mediaId: postDraftMedia.mediaId,
      altText: postDraftMedia.altText,
      ownerSubject: postMedia.ownerSubject,
      objectPath: postMedia.objectPath,
      sha256: postMedia.sha256,
      mimeType: postMedia.mimeType,
      byteSize: postMedia.byteSize,
      width: postMedia.width,
      height: postMedia.height,
      frameCount: postMedia.frameCount,
      originalFilename: postMedia.originalFilename,
      createdAt: postMedia.createdAt
    }).from(postDraftMedia).innerJoin(
      postMedia,
      eq(postDraftMedia.mediaId, postMedia.id)
    ).where(and(
      eq(postDraftMedia.postDraftId, postDraftId),
      eq(postDraftMedia.version, version)
    )).orderBy(asc(postDraftMedia.position));
  }

  async function listPostDraftMediaForVersion(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ): Promise<PostDraftMediaWithMetadata[]> {
    const rows = await postDraftMediaForVersionQuery(queryDatabase, postDraftId, version);
    return normalizeRows(rows);
  }

  async function lockPostDraftMediaForVersion(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ): Promise<PostDraftMediaWithMetadata[]> {
    const lockedDraftMedia = await queryDatabase.select({
      postDraftId: postDraftMedia.postDraftId,
      version: postDraftMedia.version,
      position: postDraftMedia.position,
      mediaId: postDraftMedia.mediaId,
      altText: postDraftMedia.altText
    }).from(postDraftMedia).where(and(
      eq(postDraftMedia.postDraftId, postDraftId),
      eq(postDraftMedia.version, version)
    )).orderBy(asc(postDraftMedia.position)).for("update");
    if (lockedDraftMedia.length === 0) {
      return [];
    }

    const sortedMediaIds = lockedDraftMedia
      .map(({ mediaId }) => mediaId.toLowerCase())
      .sort();
    if (new Set(sortedMediaIds).size !== sortedMediaIds.length) {
      return [];
    }
    const lockedMedia = await queryDatabase.select({
      id: postMedia.id,
      ownerSubject: postMedia.ownerSubject,
      objectPath: postMedia.objectPath,
      sha256: postMedia.sha256,
      mimeType: postMedia.mimeType,
      byteSize: postMedia.byteSize,
      width: postMedia.width,
      height: postMedia.height,
      frameCount: postMedia.frameCount,
      originalFilename: postMedia.originalFilename,
      createdAt: postMedia.createdAt
    }).from(postMedia).where(
      inArray(postMedia.id, sortedMediaIds)
    ).orderBy(asc(postMedia.id)).for("update");
    if (lockedMedia.length !== sortedMediaIds.length) {
      return [];
    }

    const mediaById = new Map(lockedMedia.map((media) => [
      media.id.toLowerCase(),
      normalizeRowTimestamps(media)
    ]));
    return lockedDraftMedia.flatMap((draftMedia) => {
      const media = mediaById.get(draftMedia.mediaId.toLowerCase());
      if (media === undefined) {
        return [];
      }
      const { id: _id, ...metadata } = media;
      return [{ ...draftMedia, ...metadata }];
    });
  }

  async function consumePreviewExact(
    transaction: Database,
    input: PreviewConsumptionInput
  ): Promise<PreviewConsumptionResult> {
    const [previewRow] = await transaction.select().from(postPreviews).where(
      eq(postPreviews.tokenHash, input.tokenHash)
    ).for("update");
    if (
      previewRow === undefined
      || !timingSafeTextEqual(previewRow.tokenHash, input.tokenHash)
    ) {
      return { outcome: "not_found" };
    }
    const preview = normalizeRowTimestamps(previewRow);
    if (preview.consumedAt !== null) {
      return { outcome: "already_consumed" };
    }
    if (input.consumedAt >= preview.expiresAt) {
      return { outcome: "expired" };
    }
    const [postRow] = await transaction.select().from(postDrafts).where(and(
      eq(postDrafts.id, preview.postDraftId),
      eq(postDrafts.version, preview.version)
    )).for("update");
    if (postRow === undefined) {
      return { outcome: "stale" };
    }
    const post = normalizeRowTimestamps(postRow);
    if (
      input.expected.postId !== post.draftId
      || input.expected.versionId !== post.id
      || input.expected.version !== post.version
      || input.expected.checksum !== post.checksum
      || input.expected.visibility !== post.visibility
    ) {
      return { outcome: "mismatch" };
    }
    const [latest] = await transaction.select().from(postDrafts).where(
      eq(postDrafts.draftId, post.draftId)
    ).orderBy(desc(postDrafts.version)).limit(1).for("update");
    if (latest === undefined || latest.id !== post.id) {
      return { outcome: "stale" };
    }
    if (!input.allowedStates.includes(post.state)) {
      return { outcome: "invalid_state" };
    }
    const [consumedRow] = await transaction.update(postPreviews).set({
      consumedAt: input.consumedAt
    }).where(and(
      eq(postPreviews.id, preview.id),
      isNull(postPreviews.consumedAt)
    )).returning();
    if (consumedRow === undefined) {
      return { outcome: "race" };
    }
    const consumed = normalizeRowTimestamps(consumedRow);
    if (input.claimState !== undefined) {
      const [claimed] = await transaction.update(postDrafts).set({
        state: input.claimState,
        updatedAt: nowIso()
      }).where(and(
        eq(postDrafts.id, post.id),
        eq(postDrafts.version, post.version),
        eq(postDrafts.state, post.state)
      )).returning();
      if (claimed === undefined) {
        throw new Error("Publish claim state changed before preview consumption completed");
      }
    }
    return { outcome: "consumed", post, preview: consumed };
  }

  async function claimExactPublish(input: {
    tokenHash: string;
    consumedAt: string;
    subject: string;
    imagePublishEnabled: boolean;
  }): Promise<ExactPublishClaimResult> {
    const consumedAt = assertIsoTimestamp("preview.consumedAt", input.consumedAt);
    if (!isUuid(input.subject) || !SHA256_PATTERN.test(input.tokenHash)) {
      return { outcome: "not_found" };
    }
    const subject = input.subject.toLowerCase();
    return serializableTransaction(database, async (transaction) => {
      const [previewRow] = await transaction.select().from(postPreviews).where(
        eq(postPreviews.tokenHash, input.tokenHash)
      ).for("update");
      if (
        previewRow === undefined
        || !timingSafeTextEqual(previewRow.tokenHash, input.tokenHash)
      ) {
        return { outcome: "not_found" as const };
      }
      const preview = normalizeRowTimestamps(previewRow);
      if (preview.consumedAt !== null) return { outcome: "already_consumed" as const };
      if (consumedAt >= preview.expiresAt) return { outcome: "expired" as const };

      const [postRow] = await transaction.select().from(postDrafts).where(and(
        eq(postDrafts.id, preview.postDraftId),
        eq(postDrafts.version, preview.version)
      )).for("update");
      if (postRow === undefined) return { outcome: "stale" as const };
      const post = normalizeRowTimestamps(postRow);
      if (
        !isUuid(post.id)
        || !isUuid(post.draftId)
        || !Number.isSafeInteger(post.version)
        || post.version < 1
        || typeof post.text !== "string"
        || [...post.text].length < 1
        || [...post.text].length > 3_000
        || !["PUBLIC", "CONNECTIONS"].includes(post.visibility)
      ) return { outcome: "integrity_mismatch" as const };
      const [latestRow] = await transaction.select().from(postDrafts).where(
        eq(postDrafts.draftId, post.draftId)
      ).orderBy(desc(postDrafts.version)).limit(1).for("update");
      if (latestRow === undefined || latestRow.id !== post.id) {
        return { outcome: "stale" as const };
      }
      if (post.state !== "previewed") return { outcome: "invalid_state" as const };

      const media = await lockPostDraftMediaForVersion(transaction, post.id, post.version);
      if (media.length > 4) return { outcome: "integrity_mismatch" as const };
      if (media.length > 0 && !input.imagePublishEnabled) {
        return { outcome: "image_disabled" as const };
      }
      const mediaIds = new Set<string>();
      for (let position = 0; position < media.length; position += 1) {
        const item = media[position]!;
        if (
          item.ownerSubject.toLowerCase() !== subject
          || !item.objectPath.startsWith(`${subject}/`)
        ) {
          return { outcome: "wrong_owner" as const };
        }
        if (
          item.position !== position
          || item.postDraftId !== post.id
          || item.version !== post.version
          || !isUuid(item.mediaId)
          || mediaIds.has(item.mediaId.toLowerCase())
          || !SHA256_PATTERN.test(item.sha256)
          || !["image/jpeg", "image/png", "image/gif"].includes(item.mimeType)
          || !Number.isSafeInteger(item.byteSize)
          || item.byteSize < 1
          || item.byteSize > 20 * 1024 * 1024
          || !Number.isSafeInteger(item.width)
          || !Number.isSafeInteger(item.height)
          || item.width < 1
          || item.height < 1
          || item.width * item.height >= 36_152_320
          || !Number.isSafeInteger(item.frameCount)
          || item.frameCount < 1
          || item.frameCount > 250
          || [...item.altText].length < 1
          || [...item.altText].length > 120
          || /[\r\n\u2028\u2029]/u.test(item.altText)
        ) {
          return { outcome: "integrity_mismatch" as const };
        }
        mediaIds.add(item.mediaId.toLowerCase());
      }
      let checksum: string;
      try {
        checksum = checksumLinkedInPost({
          draftId: post.draftId,
          version: post.version,
          text: post.text,
          visibility: post.visibility as "PUBLIC" | "CONNECTIONS",
          media: media.map(({ position, sha256, mimeType, altText }) => ({
            position,
            sha256,
            mimeType: mimeType as "image/jpeg" | "image/png" | "image/gif",
            altText
          }))
        });
      } catch {
        return { outcome: "integrity_mismatch" as const };
      }
      if (
        !SHA256_PATTERN.test(post.checksum)
        || !timingSafeTextEqual(checksum, post.checksum)
        || preview.snapshotChecksum === null
        || !SHA256_PATTERN.test(preview.snapshotChecksum)
        || !timingSafeTextEqual(checksum, preview.snapshotChecksum)
      ) {
        return { outcome: "integrity_mismatch" as const };
      }

      const [consumedRow] = await transaction.update(postPreviews).set({ consumedAt }).where(and(
        eq(postPreviews.id, preview.id),
        isNull(postPreviews.consumedAt)
      )).returning();
      if (consumedRow === undefined) return { outcome: "race" as const };

      const phase = media.length === 0 ? "creating_post" : "uploading_media";
      const nextState = media.length === 0 ? "publishing" : "uploading_media";
      const [attemptRow] = await transaction.insert(publishAttempts).values({
        id: randomUUID(),
        postDraftId: post.id,
        version: post.version,
        requestedAt: consumedAt,
        phase,
        mediaCount: media.length,
        responseCategory: "pending"
      }).returning();
      const attempt = requiredRow(attemptRow, "publish attempt");
      let attemptMedia: PublishAttemptMedia[] = [];
      if (media.length > 0) {
        attemptMedia = normalizeRows(await transaction.insert(publishAttemptMedia).values(
          media.map((item) => ({
            id: randomUUID(),
            publishAttemptId: attempt.id,
            mediaId: item.mediaId,
            position: item.position,
            state: "pending"
          }))
        ).returning()).sort((left, right) => left.position - right.position);
      }
      const [claimedPost] = await transaction.update(postDrafts).set({
        state: nextState,
        updatedAt: consumedAt
      }).where(and(
        eq(postDrafts.id, post.id),
        eq(postDrafts.version, post.version),
        eq(postDrafts.state, "previewed")
      )).returning();
      if (claimedPost === undefined) {
        throw new Error("Post draft state changed before exact publish claim completed");
      }
      return {
        outcome: "recorded" as const,
        post: normalizeRowTimestamps(claimedPost),
        preview: normalizeRowTimestamps(consumedRow),
        attempt,
        attemptMedia,
        media
      };
    });
  }

  function recordPublishAttempt(input: PublishAttemptRecordInput): Promise<PublishAttempt>;
  function recordPublishAttempt(
    input: PublishAttemptRecordInput,
    claim: PreviewConsumptionInput & { claimState: string }
  ): Promise<PublishClaimRecordResult>;
  async function recordPublishAttempt(
    input: PublishAttemptRecordInput,
    claim?: PreviewConsumptionInput & { claimState: string }
  ): Promise<PublishAttempt | PublishClaimRecordResult> {
    assertIsoTimestamp("publishAttempt.requestedAt", input.requestedAt);
    if (input.completedAt !== undefined && input.completedAt !== null) {
      assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
    }
    if (claim !== undefined) {
      assertIsoTimestamp("preview.consumedAt", claim.consumedAt);
    }
    return serializableTransaction(database, async (transaction) => {
      let claimed: Extract<PreviewConsumptionResult, { outcome: "consumed" }> | undefined;
      if (claim !== undefined) {
        const result = await consumePreviewExact(transaction, claim);
        if (result.outcome !== "consumed") {
          return result;
        }
        claimed = result;
        if (
          input.postDraftId !== claimed.post.id
          || input.version !== claimed.post.version
        ) {
          throw new Error("Publish attempt does not match preview claim");
        }
      }
      const [attempt] = await transaction.insert(publishAttempts).values({
        id: randomUUID(),
        ...input
      }).returning();
      const recordedAttempt = requiredRow(attempt, "publish attempt");
      return claimed === undefined
        ? recordedAttempt
        : {
            outcome: "recorded" as const,
            post: claimed.post,
            preview: claimed.preview,
            attempt: recordedAttempt
          };
    });
  }

  return {
    settings: {
      async set(key: string, value: unknown): Promise<Setting> {
        const updatedAt = nowIso();
        const [setting] = await database.insert(settings).values({
          id: randomUUID(),
          key,
          valueJson: value,
          updatedAt
        }).onConflictDoUpdate({
          target: settings.key,
          set: { valueJson: value, updatedAt }
        }).returning();
        return requiredRow(setting, "setting");
      },
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const [setting] = await database.select().from(settings).where(eq(settings.key, key));
        return setting === undefined ? undefined : setting.valueJson as T;
      }
    },
    founderResearchRuns: {
      async create(input: FounderResearchRunCreateInput): Promise<{
        run: FounderResearchRun;
        items: FounderResearchRunItem[];
      }> {
        const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
        if (
          !Number.isInteger(input.requestedLimit)
          || input.requestedLimit < 1
          || input.requestedLimit > 50
        ) {
          throw new Error("requestedLimit must be an integer from 1 through 50");
        }
        const companyIds = [...new Set(input.companyIds.map((id) => id.toLowerCase()))];
        if (
          companyIds.length !== input.companyIds.length
          || companyIds.length > input.requestedLimit
          || companyIds.some((id) => !isUuid(id))
        ) {
          throw new Error("companyIds must be unique UUIDs within requestedLimit");
        }
        return serializableTransaction(database, async (transaction) => {
          const createdAt = nowIso();
          const [runRow] = await transaction.insert(founderResearchRuns).values({
            id: randomUUID(),
            ownerSubject,
            state: "PENDING",
            queryJson: input.queryJson,
            requestedLimit: input.requestedLimit,
            selectedCount: companyIds.length,
            processedCount: 0,
            completeCount: 0,
            partialCount: 0,
            ambiguousCount: 0,
            notFoundCount: 0,
            failedCount: 0,
            createdAt,
            updatedAt: createdAt
          }).returning();
          const run = requiredRow(runRow, "founder research run");
          const itemRows = companyIds.length === 0
            ? []
            : await transaction.insert(founderResearchRunItems).values(
                companyIds.map((companyId) => ({
                  id: randomUUID(),
                  runId: run.id,
                  ownerSubject,
                  companyId,
                  state: "PENDING",
                  attemptCount: 0,
                  createdAt,
                  updatedAt: createdAt
                }))
              ).returning();
          return {
            run,
            items: normalizeRows(itemRows)
          };
        });
      },
      async getOwned(
        runId: string,
        ownerSubject: string
      ): Promise<FounderResearchRun | undefined> {
        if (!isUuid(runId) || !isUuid(ownerSubject)) {
          return undefined;
        }
        const [row] = await database.select().from(founderResearchRuns).where(and(
          eq(founderResearchRuns.id, runId),
          eq(founderResearchRuns.ownerSubject, ownerSubject.toLowerCase())
        )).limit(1);
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      },
      async recomputeCounters(
        runId: string,
        ownerSubject: string
      ): Promise<FounderResearchRun | undefined> {
        if (!isUuid(runId) || !isUuid(ownerSubject)) {
          return undefined;
        }
        return serializableTransaction(database, async (transaction) => (
          await recomputeFounderResearchRun(
            transaction,
            runId,
            ownerSubject.toLowerCase()
          )
        ));
      },
      async releaseExpiredLeases(input: {
        runId: string;
        ownerSubject: string;
        now: string;
      }): Promise<number> {
        if (!isUuid(input.runId) || !isUuid(input.ownerSubject)) {
          return 0;
        }
        const ownerSubject = input.ownerSubject.toLowerCase();
        const now = assertIsoTimestamp("founderResearchLease.now", input.now);
        return serializableTransaction(database, async (transaction) => {
          const released = await transaction.update(founderResearchRunItems).set({
            state: "PENDING",
            leaseExpiresAt: null,
            updatedAt: now
          }).where(and(
            eq(founderResearchRunItems.runId, input.runId),
            eq(founderResearchRunItems.ownerSubject, ownerSubject),
            eq(founderResearchRunItems.state, "LEASED"),
            sql`${founderResearchRunItems.leaseExpiresAt} <= ${now}`
          )).returning({ id: founderResearchRunItems.id });
          if (released.length > 0) {
            await recomputeFounderResearchRun(
              transaction,
              input.runId,
              ownerSubject,
              now
            );
          }
          return released.length;
        });
      },
      async leaseNextItems(
        input: FounderResearchLeaseInput
      ): Promise<FounderResearchRunItem[]> {
        if (!isUuid(input.runId) || !isUuid(input.ownerSubject)) {
          return [];
        }
        const ownerSubject = input.ownerSubject.toLowerCase();
        const leasedAt = assertIsoTimestamp("founderResearchLease.leasedAt", input.leasedAt);
        const leaseExpiresAt = assertIsoTimestamp(
          "founderResearchLease.leaseExpiresAt",
          input.leaseExpiresAt
        );
        if (leaseExpiresAt <= leasedAt) {
          throw new Error("leaseExpiresAt must be later than leasedAt");
        }
        const maxItems = Math.min(5, Math.max(0, Math.trunc(input.maxItems)));
        if (maxItems === 0) {
          return [];
        }

        return serializableTransaction(database, async (transaction) => {
          await transaction.update(founderResearchRunItems).set({
            state: "PENDING",
            leaseExpiresAt: null,
            updatedAt: leasedAt
          }).where(and(
            eq(founderResearchRunItems.runId, input.runId),
            eq(founderResearchRunItems.ownerSubject, ownerSubject),
            eq(founderResearchRunItems.state, "LEASED"),
            sql`${founderResearchRunItems.leaseExpiresAt} <= ${leasedAt}`
          ));

          const candidates = await transaction.select({
            item: founderResearchRunItems
          }).from(founderResearchRunItems).where(and(
            eq(founderResearchRunItems.runId, input.runId),
            eq(founderResearchRunItems.ownerSubject, ownerSubject),
            eq(founderResearchRunItems.state, "PENDING")
          )).orderBy(
            sql`(
              select ${companies.name}
              from ${companies}
              where ${companies.id} = ${founderResearchRunItems.companyId}
            )`,
            asc(founderResearchRunItems.companyId),
            asc(founderResearchRunItems.id)
          ).limit(maxItems).for("update", { skipLocked: true });

          const leased: FounderResearchRunItem[] = [];
          for (const { item } of candidates) {
            const [updated] = await transaction.update(founderResearchRunItems).set({
              state: "LEASED",
              attemptCount: sql`${founderResearchRunItems.attemptCount} + 1`,
              leaseExpiresAt,
              errorCode: null,
              errorSummary: null,
              errorDetailJson: null,
              updatedAt: leasedAt
            }).where(and(
              eq(founderResearchRunItems.id, item.id),
              eq(founderResearchRunItems.ownerSubject, ownerSubject),
              eq(founderResearchRunItems.state, "PENDING")
            )).returning();
            if (updated !== undefined) {
              leased.push(normalizeRowTimestamps(updated));
            }
          }

          if (leased.length > 0) {
            await transaction.update(founderResearchRuns).set({
              state: "RUNNING",
              startedAt: sql`coalesce(${founderResearchRuns.startedAt}, ${leasedAt})`,
              completedAt: null,
              updatedAt: leasedAt
            }).where(and(
              eq(founderResearchRuns.id, input.runId),
              eq(founderResearchRuns.ownerSubject, ownerSubject)
            ));
          }
          return leased;
        });
      },
      async completeItem(
        input: FounderResearchCompleteItemInput
      ): Promise<FounderResearchRunItem | undefined> {
        if (
          !isUuid(input.itemId)
          || !isUuid(input.ownerSubject)
          || !Number.isInteger(input.leaseAttempt)
          || input.leaseAttempt < 1
        ) {
          return undefined;
        }
        const checkedAt = assertIsoTimestamp(
          "founderResearchItem.checkedAt",
          input.checkedAt
        );
        const operationAt = nowIso();
        const [updated] = await database.update(founderResearchRunItems).set({
          state: input.state,
          leaseExpiresAt: null,
          errorCode: null,
          errorSummary: null,
          errorDetailJson: null,
          checkedAt,
          updatedAt: checkedAt
        }).where(and(
          eq(founderResearchRunItems.id, input.itemId),
          eq(founderResearchRunItems.ownerSubject, input.ownerSubject.toLowerCase()),
          eq(founderResearchRunItems.state, "LEASED"),
          eq(founderResearchRunItems.attemptCount, input.leaseAttempt),
          sql`${founderResearchRunItems.leaseExpiresAt} > ${operationAt}`
        )).returning();
        return updated === undefined ? undefined : normalizeRowTimestamps(updated);
      },
      async failItem(
        input: FounderResearchFailItemInput
      ): Promise<FounderResearchRunItem | undefined> {
        if (
          !isUuid(input.itemId)
          || !isUuid(input.ownerSubject)
          || !Number.isInteger(input.leaseAttempt)
          || input.leaseAttempt < 1
        ) {
          return undefined;
        }
        const checkedAt = assertIsoTimestamp(
          "founderResearchItem.checkedAt",
          input.checkedAt
        );
        const operationAt = nowIso();
        const [updated] = await database.update(founderResearchRunItems).set({
          state: "FAILED",
          leaseExpiresAt: null,
          errorCode: input.errorCode,
          errorSummary: input.errorSummary,
          errorDetailJson: input.errorDetailJson ?? null,
          checkedAt,
          updatedAt: checkedAt
        }).where(and(
          eq(founderResearchRunItems.id, input.itemId),
          eq(founderResearchRunItems.ownerSubject, input.ownerSubject.toLowerCase()),
          eq(founderResearchRunItems.state, "LEASED"),
          eq(founderResearchRunItems.attemptCount, input.leaseAttempt),
          sql`${founderResearchRunItems.leaseExpiresAt} > ${operationAt}`
        )).returning();
        return updated === undefined ? undefined : normalizeRowTimestamps(updated);
      }
    },
    founderResearchPeople: {
      async saveOfficial(
        input: FounderResearchPersonSaveInput
      ): Promise<FounderResearchRunPerson> {
        const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
        return serializableTransaction(database, async (transaction) => {
          const [existingRow] = await transaction.select().from(
            founderResearchRunPeople
          ).where(and(
            eq(founderResearchRunPeople.runItemId, input.runItemId),
            eq(founderResearchRunPeople.personId, input.personId),
            eq(founderResearchRunPeople.ownerSubject, ownerSubject)
          )).limit(1).for("update");
          const now = nowIso();
          if (existingRow === undefined) {
            const [inserted] = await transaction.insert(
              founderResearchRunPeople
            ).values({
              id: randomUUID(),
              runItemId: input.runItemId,
              ownerSubject,
              personId: input.personId,
              identityStatus: "VERIFIED",
              founderRoleMatch: input.founderRoleMatch,
              confidence: input.confidence,
              createdAt: now,
              updatedAt: now
            }).returning();
            return requiredRow(inserted, "founder research person");
          }
          const existing = normalizeRowTimestamps(existingRow);
          const [updated] = await transaction.update(founderResearchRunPeople).set({
            identityStatus: existing.identityStatus === "CONFIRMED"
              ? "CONFIRMED"
              : "VERIFIED",
            founderRoleMatch: input.founderRoleMatch,
            confidence: input.confidence,
            updatedAt: now
          }).where(and(
            eq(founderResearchRunPeople.id, existing.id),
            eq(founderResearchRunPeople.ownerSubject, ownerSubject)
          )).returning();
          return requiredRow(updated, "founder research person");
        }, "founder_research_run_people_item_person_unique");
      },
      async listForRun(
        runId: string,
        ownerSubject: string
      ): Promise<FounderResearchRunPerson[]> {
        if (!isUuid(runId) || !isUuid(ownerSubject)) {
          return [];
        }
        const rows = await database.select({
          person: founderResearchRunPeople
        }).from(founderResearchRunPeople).innerJoin(
          founderResearchRunItems,
          eq(founderResearchRunPeople.runItemId, founderResearchRunItems.id)
        ).where(and(
          eq(founderResearchRunItems.runId, runId),
          eq(founderResearchRunItems.ownerSubject, ownerSubject.toLowerCase()),
          eq(founderResearchRunPeople.ownerSubject, ownerSubject.toLowerCase())
        )).orderBy(
          asc(founderResearchRunItems.id),
          asc(founderResearchRunPeople.personId),
          asc(founderResearchRunPeople.id)
        );
        return normalizeRows(rows.map(({ person }) => person));
      }
    },
    founderProfileCandidates: {
      async saveCandidate(
        input: FounderProfileCandidateSaveInput
      ): Promise<FounderProfileCandidate> {
        return serializableTransaction(database, async (transaction) => (
          await upsertFounderProfileCandidate(transaction, {
            ...input,
            sourceKind: "PUBLIC_SEARCH",
            status: "CANDIDATE"
          })
        ), "founder_profile_candidates_owner_person_url_unique");
      },
      async recordOfficial(
        input: FounderProfileOfficialInput
      ): Promise<FounderProfileCandidate> {
        return serializableTransaction(database, async (transaction) => (
          await upsertFounderProfileCandidate(transaction, {
            ...input,
            status: "VERIFIED"
          })
        ), "founder_profile_candidates_owner_person_url_unique");
      },
      async confirm(
        input: FounderProfileDecisionInput
      ): Promise<FounderProfileCandidate | undefined> {
        return serializableTransaction(database, async (transaction) => (
          await decideFounderProfileCandidate(transaction, input, "CONFIRMED")
        ));
      },
      async reject(
        input: FounderProfileDecisionInput
      ): Promise<FounderProfileCandidate | undefined> {
        return serializableTransaction(database, async (transaction) => (
          await decideFounderProfileCandidate(transaction, input, "REJECTED")
        ));
      },
      async getCanonicalForPerson(
        runPersonId: string,
        ownerSubject: string
      ): Promise<FounderProfileCandidate | undefined> {
        if (!isUuid(runPersonId) || !isUuid(ownerSubject)) {
          return undefined;
        }
        const [row] = await database.select().from(founderProfileCandidates).where(and(
          eq(founderProfileCandidates.runPersonId, runPersonId),
          eq(founderProfileCandidates.ownerSubject, ownerSubject.toLowerCase()),
          inArray(founderProfileCandidates.status, ["CONFIRMED", "VERIFIED"])
        )).orderBy(
          sql`case ${founderProfileCandidates.status}
            when 'CONFIRMED' then 0
            when 'VERIFIED' then 1
            else 2
          end`,
          desc(founderProfileCandidates.checkedAt),
          asc(founderProfileCandidates.id)
        ).limit(1);
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      }
    },
    founderResearchExports: {
      async create(
        input: FounderResearchExportCreateInput
      ): Promise<FounderResearchExport> {
        const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
        const createdAt = assertIsoTimestamp("founderResearchExport.createdAt", input.createdAt);
        const expiresAt = assertIsoTimestamp("founderResearchExport.expiresAt", input.expiresAt);
        const workbookBytes = Uint8Array.from(input.workbookBytes);
        const [row] = await database.insert(founderResearchExports).values({
          id: randomUUID(),
          runId: input.runId,
          ownerSubject,
          state: "READY",
          fileName: input.fileName,
          mimeType: input.mimeType,
          byteSize: workbookBytes.byteLength,
          checksumSha256: input.checksumSha256,
          workbookBytes,
          rowCount: input.rowCount,
          sheetCount: input.sheetCount,
          createdAt,
          expiresAt
        }).returning();
        return requiredRow(row, "founder research export");
      },
      async getOwned(
        exportId: string,
        ownerSubject: string
      ): Promise<FounderResearchExport | undefined> {
        if (!isUuid(exportId) || !isUuid(ownerSubject)) {
          return undefined;
        }
        const [row] = await database.select().from(founderResearchExports).where(and(
          eq(founderResearchExports.id, exportId),
          eq(founderResearchExports.ownerSubject, ownerSubject.toLowerCase())
        )).limit(1);
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      },
      async deleteExpired(ownerSubject: string, nowInput: string): Promise<number> {
        if (!isUuid(ownerSubject)) {
          return 0;
        }
        const normalizedOwner = ownerSubject.toLowerCase();
        const now = assertIsoTimestamp("founderResearchExport.now", nowInput);
        return serializableTransaction(database, async (transaction) => {
          const expired = await transaction.select({
            id: founderResearchExports.id
          }).from(founderResearchExports).where(and(
            eq(founderResearchExports.ownerSubject, normalizedOwner),
            sql`${founderResearchExports.expiresAt} <= ${now}`
          )).for("update");
          if (expired.length === 0) {
            return 0;
          }
          const exportIds = expired.map(({ id }) => id);
          await transaction.delete(founderExportDownloadCapabilities).where(and(
            eq(founderExportDownloadCapabilities.ownerSubject, normalizedOwner),
            inArray(founderExportDownloadCapabilities.exportId, exportIds)
          ));
          const deleted = await transaction.delete(founderResearchExports).where(and(
            eq(founderResearchExports.ownerSubject, normalizedOwner),
            inArray(founderResearchExports.id, exportIds)
          )).returning({ id: founderResearchExports.id });
          return deleted.length;
        });
      }
    },
    founderExportCapabilities: {
      async create(
        input: FounderExportCapabilityCreateInput
      ): Promise<FounderExportCapability> {
        const ownerSubject = normalizeOwnerSubject(input.ownerSubject);
        const createdAt = assertIsoTimestamp("founderExportCapability.createdAt", input.createdAt);
        const expiresAt = assertIsoTimestamp("founderExportCapability.expiresAt", input.expiresAt);
        const [row] = await database.insert(founderExportDownloadCapabilities).values({
          id: randomUUID(),
          exportId: input.exportId,
          ownerSubject,
          tokenHashSha256: input.tokenHashSha256,
          expiresAt,
          createdAt
        }).returning();
        return requiredRow(row, "founder export capability");
      },
      async getUsable(input: {
        exportId: string;
        ownerSubject: string;
        tokenHashSha256: string;
        now: string;
      }): Promise<UsableFounderExportCapability | undefined> {
        if (!isUuid(input.exportId) || !isUuid(input.ownerSubject)) {
          return undefined;
        }
        const now = assertIsoTimestamp("founderExportCapability.now", input.now);
        const ownerSubject = input.ownerSubject.toLowerCase();
        const [row] = await database.select({
          capability: founderExportDownloadCapabilities,
          export: founderResearchExports
        }).from(founderExportDownloadCapabilities).innerJoin(
          founderResearchExports,
          and(
            eq(founderExportDownloadCapabilities.exportId, founderResearchExports.id),
            eq(
              founderExportDownloadCapabilities.ownerSubject,
              founderResearchExports.ownerSubject
            )
          )
        ).where(and(
          eq(founderExportDownloadCapabilities.exportId, input.exportId),
          eq(founderExportDownloadCapabilities.ownerSubject, ownerSubject),
          eq(founderExportDownloadCapabilities.tokenHashSha256, input.tokenHashSha256),
          sql`${founderExportDownloadCapabilities.expiresAt} > ${now}`,
          eq(founderResearchExports.state, "READY"),
          sql`${founderResearchExports.expiresAt} > ${now}`
        )).limit(1);
        return row === undefined
          ? undefined
          : {
              capability: normalizeRowTimestamps(row.capability),
              export: normalizeRowTimestamps(row.export)
            };
      },
      async recordDownload(input: {
        capabilityId: string;
        ownerSubject: string;
        downloadedAt: string;
      }): Promise<FounderExportCapability | undefined> {
        if (!isUuid(input.capabilityId) || !isUuid(input.ownerSubject)) {
          return undefined;
        }
        const ownerSubject = input.ownerSubject.toLowerCase();
        const downloadedAt = assertIsoTimestamp(
          "founderExportCapability.downloadedAt",
          input.downloadedAt
        );
        return serializableTransaction(database, async (transaction) => {
          const [usable] = await transaction.select({
            capability: founderExportDownloadCapabilities,
            exportState: founderResearchExports.state,
            exportExpiresAt: founderResearchExports.expiresAt
          }).from(founderExportDownloadCapabilities).innerJoin(
            founderResearchExports,
            and(
              eq(founderExportDownloadCapabilities.exportId, founderResearchExports.id),
              eq(
                founderExportDownloadCapabilities.ownerSubject,
                founderResearchExports.ownerSubject
              )
            )
          ).where(and(
            eq(founderExportDownloadCapabilities.id, input.capabilityId),
            eq(founderExportDownloadCapabilities.ownerSubject, ownerSubject)
          )).limit(1).for("update");
          if (
            usable === undefined
            || usable.exportState !== "READY"
            || new Date(usable.capability.expiresAt).getTime() <= new Date(downloadedAt).getTime()
            || new Date(usable.exportExpiresAt).getTime() <= new Date(downloadedAt).getTime()
          ) {
            return undefined;
          }
          const capability = normalizeRowTimestamps(usable.capability);
          const effectiveDownloadedAt = (
            capability.lastDownloadedAt !== null
            && capability.lastDownloadedAt > downloadedAt
          ) ? capability.lastDownloadedAt : downloadedAt;
          const [updated] = await transaction.update(
            founderExportDownloadCapabilities
          ).set({
            lastDownloadedAt: effectiveDownloadedAt
          }).where(and(
            eq(founderExportDownloadCapabilities.id, input.capabilityId),
            eq(founderExportDownloadCapabilities.ownerSubject, ownerSubject)
          )).returning();
          return updated === undefined ? undefined : normalizeRowTimestamps(updated);
        });
      }
    },
    companies: {
      async upsert(input: CompanyUpsertInput): Promise<Company> {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("company.checkedAt", input.checkedAt);
        await database.insert(companies).values({
          id: randomUUID(),
          ycId: input.ycId,
          name: input.name,
          ...(input.batch === undefined ? {} : { batch: input.batch }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
          ...(input.ycUrl === undefined ? {} : { ycUrl: input.ycUrl }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.industry === undefined ? {} : { industry: input.industry }),
          ...(input.isHiring === undefined ? {} : { isHiring: input.isHiring }),
          ...(checkedAt === undefined ? {} : { checkedAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: companies.ycId,
          set: {
            name: input.name,
            ...(input.batch === undefined ? {} : { batch: input.batch }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
            ...(input.ycUrl === undefined ? {} : { ycUrl: input.ycUrl }),
            ...(input.location === undefined ? {} : { location: input.location }),
            ...(input.industry === undefined ? {} : { industry: input.industry }),
            ...(input.isHiring === undefined ? {} : { isHiring: input.isHiring }),
            ...(checkedAt === undefined ? {} : { checkedAt }),
            updatedAt: now
          }
        });
        const [company] = await database.select().from(companies).where(eq(
          companies.ycId,
          input.ycId
        ));
        return requiredRow(company, "company");
      },
      async get(id: string): Promise<Company | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [company] = await database.select().from(companies).where(eq(companies.id, id));
        return company === undefined ? undefined : normalizeRowTimestamps(company);
      },
      async getByYcId(ycId: string): Promise<Company | undefined> {
        const [company] = await database.select().from(companies).where(eq(companies.ycId, ycId));
        return company === undefined ? undefined : normalizeRowTimestamps(company);
      },
      async list(): Promise<Company[]> {
        const rows = await database.select().from(companies).orderBy(
          asc(companies.name),
          asc(companies.id)
        );
        return normalizeRows(rows);
      }
    },
    people: {
      async upsert(input: PersonUpsertInput): Promise<Person> {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("person.checkedAt", input.checkedAt);
        await database.insert(people).values({
          id: randomUUID(),
          companyId: input.companyId,
          name: input.name,
          role: input.role,
          ...(input.publicProfileUrl === undefined ? {} : { publicProfileUrl: input.publicProfileUrl }),
          ...(checkedAt === undefined ? {} : { checkedAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: [people.companyId, people.name, people.role],
          set: {
            ...(input.publicProfileUrl === undefined ? {} : { publicProfileUrl: input.publicProfileUrl }),
            ...(checkedAt === undefined ? {} : { checkedAt }),
            updatedAt: now
          }
        });
        const [person] = await database.select().from(people).where(and(
          eq(people.companyId, input.companyId),
          eq(people.name, input.name),
          eq(people.role, input.role)
        ));
        return requiredRow(person, "person");
      },
      async get(id: string): Promise<Person | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [person] = await database.select().from(people).where(eq(people.id, id));
        return person === undefined ? undefined : normalizeRowTimestamps(person);
      },
      async listByCompany(companyId: string): Promise<Person[]> {
        if (!isUuid(companyId)) {
          return [];
        }
        const rows = await database.select().from(people).where(eq(people.companyId, companyId)).orderBy(
          asc(people.name),
          asc(people.role)
        );
        return normalizeRows(rows);
      },
      async getWithEvidence(id: string): Promise<PersonWithEvidence | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [person] = await database.select().from(people).where(eq(people.id, id));
        if (person === undefined) {
          return undefined;
        }
        const evidenceRows = await database.select().from(evidence).where(
          eq(evidence.personId, id)
        ).orderBy(asc(evidence.checkedAt), asc(evidence.id));
        return {
          ...normalizeRowTimestamps(person),
          evidence: normalizeRows(evidenceRows)
        };
      },
      async refreshDiscovery(
        input: CompanyPersonDiscoveryRefreshInput
      ): Promise<PersonWithEvidence[]> {
        return serializableTransaction(database, async (transaction) => {
          await transaction.select({ id: companies.id }).from(companies).where(
            eq(companies.id, input.companyId)
          ).for("update");
          const existingPeople = normalizeRows(await transaction.select().from(people).where(
            eq(people.companyId, input.companyId)
          ).orderBy(asc(people.name), asc(people.role), asc(people.id)));
          const existingByIdentity = new Map<string, Person>();
          for (const person of existingPeople) {
            const key = normalizedPersonIdentity(person.name, person.role);
            if (!existingByIdentity.has(key)) {
              existingByIdentity.set(key, person);
            }
          }
          const refreshed: PersonWithEvidence[] = [];
          const refreshedPersonIds = new Set<string>();
          for (const personInput of input.people) {
            const name = personInput.name.replace(/\s+/g, " ").trim();
            const role = personInput.role.replace(/\s+/g, " ").trim();
            const checkedAt = assertIsoTimestamp("person.checkedAt", personInput.checkedAt);
            const identity = normalizedPersonIdentity(name, role);
            const existing = existingByIdentity.get(identity);
            const now = nowIso();
            const [personRow] = existing === undefined
              ? await transaction.insert(people).values({
                  id: randomUUID(),
                  companyId: input.companyId,
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  createdAt: now,
                  updatedAt: now
                }).returning()
              : await transaction.update(people).set({
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  updatedAt: now
                }).where(eq(people.id, existing.id)).returning();
            const person = requiredRow(personRow, "person");
            existingByIdentity.set(identity, person);
            refreshedPersonIds.add(person.id);

            const priorDiscoveryEvidence = normalizeRows(await transaction.select().from(evidence).where(and(
              eq(evidence.personId, person.id),
              eq(evidence.factType, "public_role")
            )).orderBy(asc(evidence.sourceUrl), asc(evidence.id)));
            const unmatchedEvidence = new Set(priorDiscoveryEvidence.map((item) => item.id));
            const refreshedEvidence: Evidence[] = [];
            for (const evidenceInput of personInput.evidence) {
              const evidenceCheckedAt = assertIsoTimestamp(
                "evidence.checkedAt",
                evidenceInput.checkedAt
              );
              const prior = priorDiscoveryEvidence.find((item) => {
                return unmatchedEvidence.has(item.id)
                  && item.sourceUrl === evidenceInput.sourceUrl
                  && item.factType === (evidenceInput.factType ?? null);
              });
              const [rowResult] = prior === undefined
                ? await transaction.insert(evidence).values({
                    id: randomUUID(),
                    personId: person.id,
                    sourceUrl: evidenceInput.sourceUrl,
                    title: evidenceInput.title ?? null,
                    factType: evidenceInput.factType ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence,
                    createdAt: nowIso()
                  }).returning()
                : await transaction.update(evidence).set({
                    title: evidenceInput.title ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence
                  }).where(eq(evidence.id, prior.id)).returning();
              const row = requiredRow(rowResult, "evidence");
              if (prior !== undefined) {
                unmatchedEvidence.delete(prior.id);
              }
              refreshedEvidence.push(row);
            }
            for (const staleEvidenceId of unmatchedEvidence) {
              await transaction.delete(evidence).where(eq(evidence.id, staleEvidenceId));
            }
            refreshed.push({ ...person, evidence: refreshedEvidence });
          }
          if (input.replaceMissingDiscovery === true) {
            for (const existingPerson of existingPeople) {
              if (refreshedPersonIds.has(existingPerson.id)) {
                continue;
              }
              await transaction.delete(evidence).where(and(
                eq(evidence.personId, existingPerson.id),
                eq(evidence.factType, "public_role")
              ));
              await transaction.update(people).set({
                publicProfileUrl: null,
                checkedAt: null,
                updatedAt: nowIso()
              }).where(eq(people.id, existingPerson.id));
            }
          }
          return refreshed;
        });
      }
    },
    evidence: {
      async add(input: EvidenceAddInput): Promise<Evidence> {
        const [row] = await database.insert(evidence).values({
          id: randomUUID(),
          personId: input.personId,
          sourceUrl: input.sourceUrl,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.factType === undefined ? {} : { factType: input.factType }),
          fact: input.fact,
          checkedAt: assertIsoTimestamp("evidence.checkedAt", input.checkedAt),
          confidence: input.confidence,
          createdAt: nowIso()
        }).returning();
        return requiredRow(row, "evidence");
      },
      async get(id: string): Promise<Evidence | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [row] = await database.select().from(evidence).where(eq(evidence.id, id));
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      },
      async listForPerson(personId: string): Promise<Evidence[]> {
        if (!isUuid(personId)) {
          return [];
        }
        const rows = await database.select().from(evidence).where(eq(evidence.personId, personId)).orderBy(
          asc(evidence.checkedAt),
          asc(evidence.id)
        );
        return normalizeRows(rows);
      }
    },
    targets: {
      async upsert(input: TargetUpsertInput): Promise<Target> {
        const now = nowIso();
        const [target] = await database.insert(targets).values({
          id: randomUUID(),
          ...input,
          status: "discovered",
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: targets.personId,
          set: {
            pmmOpportunity: input.pmmOpportunity,
            referralPotential: input.referralPotential,
            networkValue: input.networkValue,
            totalScore: input.totalScore,
            confidence: input.confidence,
            rationale: input.rationale,
            updatedAt: now
          }
        }).returning();
        return requiredRow(target, "target");
      },
      async get(id: string): Promise<Target | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [target] = await database.select().from(targets).where(eq(targets.id, id));
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async getByPerson(personId: string): Promise<Target | undefined> {
        if (!isUuid(personId)) {
          return undefined;
        }
        const [target] = await database.select().from(targets).where(eq(
          targets.personId,
          personId
        ));
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async updateStatus(
        id: string,
        expectedStatus: string,
        newStatus: string
      ): Promise<Target | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [target] = await database.update(targets).set({
          status: newStatus,
          updatedAt: nowIso()
        }).where(
          and(eq(targets.id, id), eq(targets.status, expectedStatus))
        ).returning();
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async list(filter: TargetListFilter = {}): Promise<Target[]> {
        if (filter.companyId !== undefined && !isUuid(filter.companyId)) {
          return [];
        }
        const conditions = [
          ...(filter.companyId === undefined ? [] : [eq(people.companyId, filter.companyId)]),
          ...(filter.status === undefined ? [] : [eq(targets.status, filter.status)])
        ];
        const rows = await database.select({ target: targets }).from(targets).innerJoin(
          people,
          eq(targets.personId, people.id)
        ).innerJoin(
          companies,
          eq(people.companyId, companies.id)
        ).where(and(...conditions)).orderBy(
          asc(companies.name),
          asc(people.name),
          asc(people.role),
          asc(targets.id)
        );
        return rows.map((row) => normalizeRowTimestamps(row.target));
      }
    },
    notes: {
      async add(input: { targetId: string; text: string }): Promise<TargetNote> {
        const [note] = await database.insert(targetNotes).values({
          id: randomUUID(),
          targetId: input.targetId,
          text: input.text,
          createdAt: nowIso()
        }).returning();
        return requiredRow(note, "target note");
      },
      async listForTarget(targetId: string): Promise<TargetNote[]> {
        if (!isUuid(targetId)) {
          return [];
        }
        const rows = await database.select().from(targetNotes).where(
          eq(targetNotes.targetId, targetId)
        ).orderBy(asc(targetNotes.createdAt), sql`${targetNotes}.ctid`);
        return normalizeRows(rows);
      }
    },
    outreachDrafts: {
      async createVersion(input: OutreachDraftVersionInput): Promise<OutreachDraft> {
        return serializableTransaction(database, async (transaction) => {
          await transaction.select({ id: targets.id }).from(targets).where(
            eq(targets.id, input.targetId)
          ).for("update");
          const [latest] = await transaction.select().from(outreachDrafts).where(and(
            eq(outreachDrafts.targetId, input.targetId),
            eq(outreachDrafts.purpose, input.purpose)
          )).orderBy(desc(outreachDrafts.version)).limit(1).for("update");
          const now = nowIso();
          const [row] = await transaction.insert(outreachDrafts).values({
            id: randomUUID(),
            targetId: input.targetId,
            purpose: input.purpose,
            text: input.text,
            version: (latest?.version ?? 0) + 1,
            evidenceIdsJson: input.evidenceIds,
            createdAt: now,
            updatedAt: now
          }).returning();
          return decodeOutreachDraft(requiredRow(row, "outreach draft"));
        }, "outreach_target_purpose_version_unique");
      },
      async getVersion(
        targetId: string,
        purpose: string,
        version: number
      ): Promise<OutreachDraft | undefined> {
        if (!isUuid(targetId)) {
          return undefined;
        }
        const [row] = await database.select().from(outreachDrafts).where(and(
          eq(outreachDrafts.targetId, targetId),
          eq(outreachDrafts.purpose, purpose),
          eq(outreachDrafts.version, version)
        ));
        return row === undefined ? undefined : decodeOutreachDraft(row);
      },
      async listForTarget(targetId: string): Promise<OutreachDraft[]> {
        if (!isUuid(targetId)) {
          return [];
        }
        const rows = await database.select().from(outreachDrafts).where(
          eq(outreachDrafts.targetId, targetId)
        ).orderBy(asc(outreachDrafts.purpose), asc(outreachDrafts.version));
        return rows.map(decodeOutreachDraft);
      }
    },
    shortlists: {
      async create(input: { name: string; targetIds: string[] }): Promise<Shortlist> {
        return database.transaction(async (transaction) => {
          const now = nowIso();
          const [shortlistRow] = await transaction.insert(shortlists).values({
            id: randomUUID(),
            name: input.name,
            createdAt: now,
            updatedAt: now
          }).returning();
          const shortlist = requiredRow(shortlistRow, "shortlist");
          if (input.targetIds.length > 0) {
            await transaction.insert(shortlistEntries).values(input.targetIds.map((targetId, position) => ({
              id: randomUUID(),
              shortlistId: shortlist.id,
              targetId,
              position,
              createdAt: now
            })));
          }
          return shortlist;
        });
      },
      async getWithEntries(id: string): Promise<ShortlistWithEntries | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [shortlist] = await database.select().from(shortlists).where(eq(shortlists.id, id));
        if (shortlist === undefined) {
          return undefined;
        }
        const entries = await database.select().from(shortlistEntries).where(
          eq(shortlistEntries.shortlistId, id)
        ).orderBy(asc(shortlistEntries.position));
        return {
          ...normalizeRowTimestamps(shortlist),
          entries: normalizeRows(entries)
        };
      },
      async list(): Promise<Shortlist[]> {
        const rows = await database.select().from(shortlists).orderBy(
          asc(shortlists.createdAt),
          asc(shortlists.id)
        );
        return normalizeRows(rows);
      }
    },
    brandProfiles: {
      async getActive(ownerSubject: string): Promise<BrandProfile | undefined> {
        if (!isUuid(ownerSubject)) {
          return undefined;
        }
        const [profile] = await database.select().from(brandProfiles).where(and(
          eq(brandProfiles.ownerSubject, ownerSubject),
          eq(brandProfiles.state, "active")
        )).limit(1);
        return profile === undefined ? undefined : normalizeRowTimestamps(profile);
      },
      async ensureDefault(input: BrandProfileDefaultInput): Promise<BrandProfile> {
        if (!isUuid(input.id) || !isUuid(input.ownerSubject)) {
          throw new Error("Brand profile id and ownerSubject must be valid UUIDs");
        }
        return serializableTransaction(database, async (transaction) => {
          const [active] = await transaction.select().from(brandProfiles).where(and(
            eq(brandProfiles.ownerSubject, input.ownerSubject),
            eq(brandProfiles.state, "active")
          )).limit(1).for("update");
          if (active !== undefined) {
            return normalizeRowTimestamps(active);
          }
          const [profile] = await transaction.insert(brandProfiles).values({
            ...input,
            version: 1,
            state: "active",
            createdAt: nowIso()
          }).returning();
          return requiredRow(profile, "brand profile");
        }, "brand_profiles_one_active_owner_unique");
      }
    },
    brandVisualBriefs: {
      async create(
        input: BrandVisualBriefCreateInput
      ): Promise<BrandVisualBrief> {
        if (
          !isUuid(input.id)
          || !isUuid(input.ownerSubject)
          || !isUuid(input.postDraftId)
          || !isUuid(input.brandProfileId)
        ) {
          throw new Error("Brand visual brief identifiers must be valid UUIDs");
        }
        return serializableTransaction(database, async (transaction) => {
          await lockLatestOwnedBrandBriefSource(transaction, input);
          const [profile] = await transaction.select({ id: brandProfiles.id }).from(brandProfiles).where(and(
            eq(brandProfiles.id, input.brandProfileId),
            eq(brandProfiles.version, input.brandProfileVersion),
            eq(brandProfiles.ownerSubject, input.ownerSubject)
          )).limit(1).for("update");
          if (profile === undefined) {
            throw new Error("Brand visual brief profile must be owned by the request subject");
          }
          await rejectRecentBrandHook(transaction, input);
          return insertBrandVisualBrief(transaction, input);
        });
      },
      async createWithDefaultProfile(
        input: BrandVisualBriefWithDefaultProfileInput
      ): Promise<{ profile: BrandProfile; brief: BrandVisualBrief }> {
        if (
          !isUuid(input.profile.id)
          || !isUuid(input.profile.ownerSubject)
          || !isUuid(input.brief.id)
          || !isUuid(input.brief.ownerSubject)
          || !isUuid(input.brief.postDraftId)
          || input.profile.ownerSubject.toLowerCase()
            !== input.brief.ownerSubject.toLowerCase()
        ) {
          throw new Error("Atomic brand profile and brief identifiers must be valid and owned");
        }
        return serializableTransaction(database, async (transaction) => {
          await lockLatestOwnedBrandBriefSource(transaction, input.brief);
          const [activeRow] = await transaction.select().from(brandProfiles).where(and(
            eq(brandProfiles.ownerSubject, input.profile.ownerSubject),
            eq(brandProfiles.state, "active")
          )).limit(1).for("update");
          let profile: BrandProfile;
          if (activeRow === undefined) {
            const [profileRow] = await transaction.insert(brandProfiles).values({
              ...input.profile,
              version: 1,
              state: "active",
              createdAt: nowIso()
            }).returning();
            profile = requiredRow(profileRow, "brand profile");
          } else {
            profile = normalizeRowTimestamps(activeRow);
            if (!profileMatchesDefaultInput(profile, input.profile)) {
              throw new DomainError(
                "DATA_INTEGRITY",
                "Brand profile configuration is invalid",
                { entity: "brand_profile" }
              );
            }
          }
          await rejectRecentBrandHook(transaction, input.brief);
          const brief = await insertBrandVisualBrief(transaction, {
            ...input.brief,
            brandProfileId: profile.id,
            brandProfileVersion: profile.version
          });
          return { profile, brief };
        }, "brand_profiles_one_active_owner_unique");
      },
      async getOwned(id: string, ownerSubject: string): Promise<BrandVisualBrief | undefined> {
        if (!isUuid(id) || !isUuid(ownerSubject)) {
          return undefined;
        }
        const [brief] = await database.select().from(brandVisualBriefs).where(and(
          eq(brandVisualBriefs.id, id),
          eq(brandVisualBriefs.ownerSubject, ownerSubject)
        ));
        return brief === undefined ? undefined : normalizeRowTimestamps(brief);
      },
      async listRecent(ownerSubject: string, limit: number): Promise<BrandVisualBrief[]> {
        if (!isUuid(ownerSubject)) {
          return [];
        }
        const boundedLimit = Number.isFinite(limit)
          ? Math.min(Math.max(Math.floor(limit), 1), 50)
          : 1;
        const rows = await database.select().from(brandVisualBriefs).where(
          eq(brandVisualBriefs.ownerSubject, ownerSubject)
        ).orderBy(desc(brandVisualBriefs.createdAt), desc(brandVisualBriefs.id)).limit(boundedLimit);
        return normalizeRows(rows);
      }
    },
    brandVisualRenders: {
      async commitAndAttach(
        input: BrandVisualRenderCommitInput
      ): Promise<{ post: PostDraft; render: BrandVisualRender }> {
        const validationError = (field: string, reason: string) => (
          new DomainError("VALIDATION_ERROR", "Brand render input is invalid", {
            field,
            reason
          })
        );
        const briefNotFound = () => (
          new DomainError("NOT_FOUND", "Brand visual brief was not found", {
            entity: "brand_visual_brief"
          })
        );
        const postNotFound = () => (
          new DomainError("NOT_FOUND", "Brand visual brief source was not found", {
            entity: "post_draft"
          })
        );
        const mediaNotFound = () => (
          new DomainError("NOT_FOUND", "Brand render media was not found", {
            entity: "post_media"
          })
        );
        const integrityError = brandRenderIntegrityError;
        const conflictError = () => (
          new DomainError("CONFLICT", "Brand visual brief is not ready", {
            entity: "brand_visual_brief"
          })
        );

        if (!isUuid(input.ownerSubject)) {
          throw validationError("ownerSubject", "must_be_uuid");
        }
        if (!isUuid(input.briefId)) {
          throw validationError("briefId", "must_be_uuid");
        }
        if (!isUuid(input.expectedDraftId)) {
          throw validationError("expectedDraftId", "must_be_uuid");
        }
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
          throw validationError("expectedVersion", "must_be_positive_integer");
        }
        if (!isUuid(input.renderedMediaId)) {
          throw validationError("renderedMediaId", "must_be_uuid");
        }
        if (input.sourceMediaId !== undefined && !isUuid(input.sourceMediaId)) {
          throw validationError("sourceMediaId", "must_be_uuid");
        }
        if (
          typeof input.altText !== "string"
          || [...input.altText].length < 1
          || [...input.altText].length > 120
          || input.altText.trim().length < 1
          || /[\r\n\u2028\u2029]/u.test(input.altText)
        ) {
          throw validationError("altText", "invalid");
        }
        if (!SHA256_PATTERN.test(input.renderChecksum)) {
          throw validationError("renderChecksum", "must_be_sha256");
        }
        if (!Number.isSafeInteger(input.rendererVersion) || input.rendererVersion < 1) {
          throw validationError("rendererVersion", "must_be_positive_integer");
        }
        if (typeof input.checksum !== "function") {
          throw validationError("checksum", "must_be_function");
        }

        const ownerSubject = input.ownerSubject.toLowerCase();
        const briefId = input.briefId.toLowerCase();
        const expectedDraftId = input.expectedDraftId.toLowerCase();
        const renderedMediaId = input.renderedMediaId.toLowerCase();
        const sourceMediaId = input.sourceMediaId?.toLowerCase();
        return serializableTransaction(database, async (transaction) => {
          const [initialBriefRow] = await transaction.select().from(
            brandVisualBriefs
          ).where(and(
            eq(brandVisualBriefs.id, briefId),
            eq(brandVisualBriefs.ownerSubject, ownerSubject)
          )).limit(1);
          if (initialBriefRow === undefined) {
            throw briefNotFound();
          }
          const initialBrief = normalizeRowTimestamps(initialBriefRow);

          const [sourceClaim] = await transaction.select({
            briefId: brandBriefSourceClaims.briefId
          }).from(brandBriefSourceClaims).where(and(
            eq(brandBriefSourceClaims.briefId, initialBrief.id),
            eq(brandBriefSourceClaims.ownerSubject, ownerSubject),
            eq(brandBriefSourceClaims.postDraftId, initialBrief.postDraftId),
            eq(brandBriefSourceClaims.postVersion, initialBrief.postVersion)
          )).limit(1);
          if (sourceClaim === undefined) {
            throw postNotFound();
          }

          const [reference] = await transaction.select().from(postDrafts).where(and(
            eq(postDrafts.id, initialBrief.postDraftId),
            eq(postDrafts.version, initialBrief.postVersion)
          )).limit(1);
          if (
            reference === undefined
            || reference.draftId.toLowerCase() !== expectedDraftId
          ) {
            throw postNotFound();
          }

          if (sourceMediaId !== undefined) {
            const [initialSourceMedia] = await transaction.select().from(
              postMedia
            ).where(and(
              eq(postMedia.id, sourceMediaId),
              eq(postMedia.ownerSubject, ownerSubject)
            )).limit(1);
            if (
              initialSourceMedia === undefined
              || !initialSourceMedia.objectPath.startsWith(`${ownerSubject}/`)
              || !SHA256_PATTERN.test(initialSourceMedia.sha256)
            ) {
              throw mediaNotFound();
            }
            if (sourceMediaId === renderedMediaId) {
              throw integrityError();
            }
          }

          const [latestRow] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, reference.draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          if (latestRow === undefined) {
            throw postNotFound();
          }
          const latest = normalizeRowTimestamps(latestRow);
          await validateOwnedBrandPostMedia(transaction, {
            postDraftId: reference.id,
            version: reference.version,
            ownerSubject
          });
          await validateOwnedBrandPostMedia(transaction, {
            postDraftId: latest.id,
            version: latest.version,
            ownerSubject
          });
          if (
            latest.id !== reference.id
            || latest.version !== reference.version
            || latest.version !== input.expectedVersion
            || initialBrief.postVersion !== input.expectedVersion
          ) {
            throw new DomainError("CONFLICT", "Post draft version is stale", {
              entity: "post_draft",
              expectedVersion: input.expectedVersion,
              actualVersion: latest.version
            });
          }
          const exact = latest;

          const exactDraftMedia = await transaction.select().from(
            postDraftMedia
          ).where(and(
            eq(postDraftMedia.postDraftId, exact.id),
            eq(postDraftMedia.version, exact.version)
          )).orderBy(asc(postDraftMedia.position)).for("update");
          const latestDraftMedia = exactDraftMedia;

          const sortedMediaIds = [...new Set([
            ...exactDraftMedia.map(({ mediaId }) => mediaId.toLowerCase()),
            ...latestDraftMedia.map(({ mediaId }) => mediaId.toLowerCase()),
            ...(sourceMediaId === undefined ? [] : [sourceMediaId]),
            renderedMediaId
          ])].sort();
          const lockedMedia = await transaction.select().from(postMedia).where(
            inArray(postMedia.id, sortedMediaIds)
          ).orderBy(asc(postMedia.id)).for("update");
          if (lockedMedia.length !== sortedMediaIds.length) {
            throw mediaNotFound();
          }
          const mediaById = new Map(lockedMedia.map((media) => [
            media.id.toLowerCase(),
            normalizeRowTimestamps(media)
          ]));
          const isOwnedMedia = (media: PostMedia | undefined): media is PostMedia => (
            media !== undefined
            && media.ownerSubject.toLowerCase() === ownerSubject
            && media.objectPath.startsWith(`${ownerSubject}/`)
            && SHA256_PATTERN.test(media.sha256)
          );
          if (
            exactDraftMedia.some(({ mediaId }) => (
              !isOwnedMedia(mediaById.get(mediaId.toLowerCase()))
            ))
            || latestDraftMedia.some(({ mediaId }) => (
              !isOwnedMedia(mediaById.get(mediaId.toLowerCase()))
            ))
          ) {
            throw postNotFound();
          }

          const renderedMedia = mediaById.get(renderedMediaId);
          const sourceMedia = sourceMediaId === undefined
            ? undefined
            : mediaById.get(sourceMediaId);
          if (!isOwnedMedia(renderedMedia)) {
            throw mediaNotFound();
          }
          if (sourceMediaId !== undefined && !isOwnedMedia(sourceMedia)) {
            throw mediaNotFound();
          }
          if (sourceMediaId !== undefined) {
            const sourceAttachments = await transaction.select({
              mediaId: postDraftMedia.mediaId
            }).from(postDraftMedia).where(
              eq(postDraftMedia.mediaId, sourceMediaId)
            ).orderBy(
              asc(postDraftMedia.postDraftId),
              asc(postDraftMedia.version),
              asc(postDraftMedia.position)
            );
            if (sourceAttachments.length > 0) {
              throw integrityError();
            }
            const [sourceClaim] = await transaction.select({
              purpose: mediaUsageClaims.purpose
            }).from(mediaUsageClaims).where(and(
              eq(mediaUsageClaims.mediaId, sourceMediaId),
              eq(mediaUsageClaims.purpose, "attached")
            )).limit(1);
            if (sourceClaim !== undefined) {
              throw integrityError();
            }
          }
          await rejectBrandSourceMediaAttachments(transaction, [renderedMediaId]);

          const [profile] = await transaction.select().from(brandProfiles).where(and(
            eq(brandProfiles.id, initialBrief.brandProfileId),
            eq(brandProfiles.version, initialBrief.brandProfileVersion),
            eq(brandProfiles.ownerSubject, ownerSubject)
          )).limit(1).for("update");
          if (profile === undefined) {
            throw briefNotFound();
          }

          const [lockedBriefRow] = await transaction.select().from(
            brandVisualBriefs
          ).where(and(
            eq(brandVisualBriefs.id, briefId),
            eq(brandVisualBriefs.ownerSubject, ownerSubject)
          )).limit(1).for("update");
          if (lockedBriefRow === undefined) {
            throw briefNotFound();
          }
          const brief = normalizeRowTimestamps(lockedBriefRow);
          if (
            brief.postDraftId !== initialBrief.postDraftId
            || brief.postVersion !== initialBrief.postVersion
            || brief.brandProfileId !== initialBrief.brandProfileId
            || brief.brandProfileVersion !== initialBrief.brandProfileVersion
            || brief.templateId !== initialBrief.templateId
            || brief.templateVersion !== initialBrief.templateVersion
            || brief.visualMode !== initialBrief.visualMode
          ) {
            throw integrityError();
          }
          if (brief.state !== "ready") {
            throw conflictError();
          }
          if (brief.postVersion !== input.expectedVersion) {
            throw integrityError();
          }
          if (
            (brief.visualMode === "EDITORIAL_STATEMENT" && sourceMediaId !== undefined)
            || (brief.visualMode === "EDITORIAL_METAPHOR" && sourceMediaId === undefined)
            || (
              brief.visualMode !== "EDITORIAL_STATEMENT"
              && brief.visualMode !== "EDITORIAL_METAPHOR"
            )
          ) {
            throw integrityError();
          }
          if (
            renderedMedia.mimeType !== "image/png"
            || renderedMedia.width !== 1080
            || renderedMedia.height !== 1350
            || renderedMedia.frameCount !== 1
            || !timingSafeTextEqual(input.renderChecksum, renderedMedia.sha256)
          ) {
            throw integrityError();
          }

          const existingRenders = await transaction.select({
            id: brandVisualRenders.id
          }).from(brandVisualRenders).where(
            eq(brandVisualRenders.briefId, brief.id)
          ).orderBy(desc(brandVisualRenders.version), desc(brandVisualRenders.id))
            .for("update");
          if (existingRenders.length > 0) {
            throw conflictError();
          }

          const nextVersion = latest.version + 1;
          const checksumMedia = Object.freeze([Object.freeze({
            position: 0,
            sha256: renderedMedia.sha256,
            mimeType: renderedMedia.mimeType,
            altText: input.altText
          })]);
          const postChecksum = input.checksum(
            nextVersion,
            latest.draftId,
            checksumMedia
          );
          if (!SHA256_PATTERN.test(postChecksum)) {
            throw integrityError();
          }
          const now = nowIso();
          const [postRow] = await transaction.insert(postDrafts).values({
            id: randomUUID(),
            draftId: latest.draftId,
            ownerSubject,
            text: exact.text,
            visibility: exact.visibility,
            version: nextVersion,
            checksum: postChecksum,
            state: "draft",
            createdAt: now,
            updatedAt: now
          }).returning();
          const post = requiredRow(postRow, "post draft");
          await transaction.insert(postDraftMedia).values({
            postDraftId: post.id,
            version: post.version,
            position: 0,
            mediaId: renderedMedia.id,
            altText: input.altText
          });
          const [renderRow] = await transaction.insert(brandVisualRenders).values({
            id: randomUUID(),
            ownerSubject,
            briefId: brief.id,
            version: 1,
            ...(sourceMediaId === undefined ? {} : { sourceMediaId }),
            renderedMediaId: renderedMedia.id,
            altText: input.altText,
            renderChecksum: input.renderChecksum,
            rendererVersion: input.rendererVersion,
            createdAt: now
          }).returning();
          const render = requiredRow(renderRow, "brand visual render");
          const [updatedBrief] = await transaction.update(brandVisualBriefs).set({
            state: "rendered"
          }).where(and(
            eq(brandVisualBriefs.id, brief.id),
            eq(brandVisualBriefs.ownerSubject, ownerSubject),
            eq(brandVisualBriefs.state, "ready")
          )).returning({ id: brandVisualBriefs.id });
          if (updatedBrief === undefined) {
            throw conflictError();
          }
          return { post, render };
        }, [
          "post_draft_version_unique",
          "brand_visual_renders_brief_version_unique"
        ]);
      },

      async getByRenderedMedia(
        ownerSubject: string,
        mediaId: string
      ): Promise<(BrandVisualRender & {
        brief: BrandVisualBrief;
        profile: BrandProfile;
        renderedMediaSha256: string;
      }) | undefined> {
        if (!isUuid(ownerSubject) || !isUuid(mediaId)) {
          return undefined;
        }
        const [row] = await database.select({
          render: brandVisualRenders,
          brief: brandVisualBriefs,
          profile: brandProfiles,
          renderedMediaSha256: postMedia.sha256
        }).from(brandVisualRenders).innerJoin(
          brandVisualBriefs,
          eq(brandVisualRenders.briefId, brandVisualBriefs.id)
        ).innerJoin(
          postMedia,
          eq(brandVisualRenders.renderedMediaId, postMedia.id)
        ).innerJoin(brandProfiles, and(
          eq(brandVisualBriefs.brandProfileId, brandProfiles.id),
          eq(brandVisualBriefs.brandProfileVersion, brandProfiles.version)
        )).where(and(
          eq(brandVisualRenders.ownerSubject, ownerSubject),
          eq(brandVisualRenders.renderedMediaId, mediaId),
          eq(brandVisualBriefs.ownerSubject, ownerSubject),
          eq(postMedia.ownerSubject, ownerSubject),
          eq(brandProfiles.ownerSubject, ownerSubject)
        )).orderBy(desc(brandVisualRenders.createdAt), desc(brandVisualRenders.id)).limit(1);
        return row === undefined
          ? undefined
          : {
              ...normalizeRowTimestamps(row.render),
              brief: normalizeRowTimestamps(row.brief),
              profile: normalizeRowTimestamps(row.profile),
              renderedMediaSha256: row.renderedMediaSha256
            };
      }
    },
    postMedia: {
      async create(input: PostMediaCreateInput): Promise<PostMedia> {
        const { createdAt: requestedCreatedAt, ...values } = input;
        const createdAt = requestedCreatedAt === undefined
          ? nowIso()
          : assertIsoTimestamp("postMedia.createdAt", requestedCreatedAt);
        const [media] = await database.insert(postMedia).values({
          ...values,
          createdAt
        }).returning();
        return requiredRow(media, "post media");
      },
      async get(id: string): Promise<PostMedia | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [media] = await database.select().from(postMedia).where(eq(postMedia.id, id));
        return media === undefined ? undefined : normalizeRowTimestamps(media);
      },
      async getByOwnerAndSha(
        ownerSubject: string,
        sha256: string
      ): Promise<PostMedia | undefined> {
        if (!isUuid(ownerSubject) || !SHA256_PATTERN.test(sha256)) {
          return undefined;
        }
        const [media] = await database.select().from(postMedia).where(and(
          eq(postMedia.ownerSubject, ownerSubject),
          eq(postMedia.sha256, sha256)
        ));
        return media === undefined ? undefined : normalizeRowTimestamps(media);
      },
      async deleteOwnedUnreferenced(
        ownerSubject: string,
        ids: readonly string[]
      ): Promise<string[]> {
        if (
          !isUuid(ownerSubject)
          || ids.length === 0
          || ids.some((id) => !isUuid(id))
        ) {
          return [];
        }
        const rows = await database.delete(postMedia).where(and(
          eq(postMedia.ownerSubject, ownerSubject),
          inArray(postMedia.id, [...ids]),
          notExists(database.select({ id: postDraftMedia.mediaId }).from(postDraftMedia).where(
            eq(postDraftMedia.mediaId, postMedia.id)
          )),
          notExists(database.select({ id: brandVisualRenders.id }).from(
            brandVisualRenders
          ).where(or(
            eq(brandVisualRenders.sourceMediaId, postMedia.id),
            eq(brandVisualRenders.renderedMediaId, postMedia.id)
          )))
        )).returning({ id: postMedia.id });
        return rows.map(({ id }) => id);
      }
    },
    postDraftMedia: {
      async listForVersion(
        postDraftId: string,
        version: number
      ): Promise<PostDraftMediaWithMetadata[]> {
        if (!isUuid(postDraftId) || !Number.isInteger(version)) {
          return [];
        }
        return listPostDraftMediaForVersion(database, postDraftId, version);
      }
    },
    postDraftOwners: {
      async getOwner(draftId: string): Promise<string | undefined> {
        if (!isUuid(draftId)) {
          return undefined;
        }
        const [owner] = await database.select({
          ownerSubject: postDraftOwners.ownerSubject
        }).from(postDraftOwners).where(
          eq(postDraftOwners.draftId, draftId)
        ).limit(1);
        return owner?.ownerSubject;
      }
    },
    postDrafts: {
      async createVersion(input: PostDraftVersionInput): Promise<PostDraft> {
        if (!isUuid(input.ownerSubject)) {
          throw new Error("ownerSubject must be a valid UUID");
        }
        const draftId = input.draftId ?? randomUUID();
        const ownerSubject = input.ownerSubject.toLowerCase();
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          const version = (latest?.version ?? 0) + 1;
          const now = nowIso();
          const [post] = await transaction.insert(postDrafts).values({
            id: randomUUID(),
            draftId,
            ownerSubject,
            text: input.text,
            visibility: input.visibility,
            version,
            checksum: typeof input.checksum === "function"
              ? input.checksum(version)
              : input.checksum,
            state: input.state,
            createdAt: now,
            updatedAt: now
          }).returning();
          return requiredRow(post, "post draft");
        }, "post_draft_version_unique");
      },
      async createVersionWithMedia(
        input: PostDraftVersionWithMediaInput
      ): Promise<{ post: PostDraft; media: PostDraftMediaWithMetadata[] }> {
        if (!isUuid(input.ownerSubject)) {
          throw new Error("ownerSubject must be a valid UUID");
        }
        const ownerSubject = input.ownerSubject.toLowerCase();
        if (input.media.length > 4) {
          throw new Error("A post draft version can contain at most four media items");
        }
        if (input.media.some(({ mediaId }) => !isUuid(mediaId))) {
          throw new Error("Every mediaId must be a valid UUID");
        }
        const normalizedMediaIds = input.media.map(({ mediaId }) => mediaId.toLowerCase());
        if (new Set(normalizedMediaIds).size !== normalizedMediaIds.length) {
          throw new Error("A post draft version cannot contain duplicate media items");
        }
        const draftId = input.draftId ?? randomUUID();
        const sortedMediaIds = [...normalizedMediaIds].sort();
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          if (
            input.expectedVersion !== undefined
            && latest?.version !== input.expectedVersion
          ) {
            throw new PostDraftVersionConflictError();
          }
          const lockedMedia = sortedMediaIds.length === 0
            ? []
            : await transaction.select({
                id: postMedia.id,
                ownerSubject: postMedia.ownerSubject,
                objectPath: postMedia.objectPath,
                sha256: postMedia.sha256,
                mimeType: postMedia.mimeType,
                byteSize: postMedia.byteSize,
                width: postMedia.width,
                height: postMedia.height,
                frameCount: postMedia.frameCount,
                originalFilename: postMedia.originalFilename,
                createdAt: postMedia.createdAt
              }).from(postMedia).where(
                inArray(postMedia.id, sortedMediaIds)
              ).orderBy(asc(postMedia.id)).for("update");
          if (
            lockedMedia.length !== sortedMediaIds.length
            || lockedMedia.some(({ ownerSubject: mediaOwnerSubject }) => (
              mediaOwnerSubject.toLowerCase() !== ownerSubject
            ))
          ) {
            throw new Error("Every media item must exist and be owned by the request subject");
          }
          await rejectBrandSourceMediaAttachments(transaction, sortedMediaIds);
          const version = (latest?.version ?? 0) + 1;
          const now = nowIso();
          const lockedById = new Map(lockedMedia.map((media) => [media.id.toLowerCase(), media]));
          const checksumMedia = input.media.map((item, position) => {
            const media = lockedById.get(item.mediaId.toLowerCase());
            if (media === undefined) {
              throw new Error("Every media item must exist and be owned by the request subject");
            }
            return {
              position,
              sha256: media.sha256,
              mimeType: media.mimeType,
              altText: item.altText
            };
          });
          const [postRow] = await transaction.insert(postDrafts).values({
            id: randomUUID(),
            draftId,
            ownerSubject,
            text: input.text,
            visibility: input.visibility,
            version,
            checksum: typeof input.checksum === "function"
              ? input.checksum(version, draftId, checksumMedia)
              : input.checksum,
            state: input.state,
            createdAt: now,
            updatedAt: now
          }).returning();
          const post = requiredRow(postRow, "post draft");
          if (input.media.length > 0) {
            await transaction.insert(postDraftMedia).values(input.media.map((media, position) => ({
              postDraftId: post.id,
              version: post.version,
              position,
              mediaId: media.mediaId,
              altText: media.altText
            })));
          }
          return {
            post,
            media: await listPostDraftMediaForVersion(transaction, post.id, post.version)
          };
        }, "post_draft_version_unique");
      },
      async getVersion(draftId: string, version: number): Promise<PostDraft | undefined> {
        if (!isUuid(draftId)) {
          return undefined;
        }
        const [post] = await database.select().from(postDrafts).where(and(
          eq(postDrafts.draftId, draftId),
          eq(postDrafts.version, version)
        ));
        return post === undefined ? undefined : normalizeRowTimestamps(post);
      },
      async listVersions(draftId: string): Promise<PostDraft[]> {
        if (!isUuid(draftId)) {
          return [];
        }
        const rows = await database.select().from(postDrafts).where(eq(postDrafts.draftId, draftId)).orderBy(
          asc(postDrafts.version)
        );
        return normalizeRows(rows);
      },
      async transitionState(input: {
        versionId: string;
        version: number;
        expectedState: string;
        nextState: string;
      }): Promise<PostDraft | undefined> {
        if (!isUuid(input.versionId)) {
          return undefined;
        }
        const [post] = await database.update(postDrafts).set({
          state: input.nextState,
          updatedAt: nowIso()
        }).where(and(
          eq(postDrafts.id, input.versionId),
          eq(postDrafts.version, input.version),
          eq(postDrafts.state, input.expectedState)
        )).returning();
        return post === undefined ? undefined : normalizeRowTimestamps(post);
      }
    },
    previews: {
      async create(
        input: Omit<typeof postPreviews.$inferInsert, "id" | "consumedAt">
      ): Promise<PostPreview> {
        const [preview] = await database.insert(postPreviews).values({
          id: randomUUID(),
          ...input,
          expiresAt: assertIsoTimestamp("preview.expiresAt", input.expiresAt)
        }).returning();
        return requiredRow(preview, "post preview");
      },
      async getByTokenHash(tokenHash: string): Promise<PostPreview | undefined> {
        const [preview] = await database.select().from(postPreviews).where(
          eq(postPreviews.tokenHash, tokenHash)
        );
        return preview === undefined ? undefined : normalizeRowTimestamps(preview);
      },
      async listForPostDraft(postDraftId: string): Promise<PostPreview[]> {
        if (!isUuid(postDraftId)) {
          return [];
        }
        const rows = await database.select().from(postPreviews).where(
          eq(postPreviews.postDraftId, postDraftId)
        ).orderBy(asc(postPreviews.expiresAt), asc(postPreviews.id));
        return normalizeRows(rows);
      },
      async createForLatest(input: {
        draftId: string;
        version: number;
        tokenHash: string;
        expiresAt: string;
        allowedStates: readonly string[];
        expectedVersionId?: string;
        expectedChecksum?: string;
        snapshotChecksum?: string;
        replaceUnconsumedAt?: string;
        nextState?: string;
        expectedSnapshot?: ExactPreviewSnapshotExpected;
      }): Promise<PreviewCreationResult> {
        const expiresAt = assertIsoTimestamp("preview.expiresAt", input.expiresAt);
        const replaceUnconsumedAt = input.replaceUnconsumedAt === undefined
          ? undefined
          : assertIsoTimestamp("preview.replaceUnconsumedAt", input.replaceUnconsumedAt);
        if (!isUuid(input.draftId)) {
          return { outcome: "not_found" };
        }
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, input.draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          if (latest === undefined) {
            return { outcome: "not_found" };
          }
          const [postRow] = latest.version === input.version
            ? [latest]
            : await transaction.select().from(postDrafts).where(and(
                eq(postDrafts.draftId, input.draftId),
                eq(postDrafts.version, input.version)
              ));
          if (postRow === undefined) {
            return { outcome: "not_found" };
          }
          const post = normalizeRowTimestamps(postRow);
          if (latest.id !== post.id) {
            return { outcome: "not_latest" };
          }
          if (
            (input.expectedVersionId !== undefined && input.expectedVersionId !== post.id)
            || (input.expectedChecksum !== undefined && input.expectedChecksum !== post.checksum)
          ) {
            return { outcome: "integrity_mismatch" };
          }
          if (input.expectedSnapshot !== undefined) {
            const lockedMedia = await lockPostDraftMediaForVersion(
              transaction,
              post.id,
              post.version
            );
            if (!exactPreviewSnapshotMatches(post, lockedMedia, input.expectedSnapshot)) {
              return { outcome: "integrity_mismatch" };
            }
          }
          if (!input.allowedStates.includes(post.state)) {
            return { outcome: "invalid_state" };
          }
          if (replaceUnconsumedAt !== undefined) {
            await transaction.update(postPreviews).set({
              consumedAt: replaceUnconsumedAt
            }).where(and(
              eq(postPreviews.postDraftId, post.id),
              eq(postPreviews.version, post.version),
              isNull(postPreviews.consumedAt)
            ));
          }
          const [previewRow] = await transaction.insert(postPreviews).values({
            id: randomUUID(),
            postDraftId: post.id,
            version: post.version,
            tokenHash: input.tokenHash,
            ...(input.snapshotChecksum === undefined
              ? {}
              : { snapshotChecksum: input.snapshotChecksum }),
            expiresAt
          }).returning();
          const preview = requiredRow(previewRow, "post preview");
          if (input.nextState === undefined || input.nextState === post.state) {
            return { outcome: "created", post, preview };
          }
          const [updatedPostRow] = await transaction.update(postDrafts).set({
            state: input.nextState,
            updatedAt: replaceUnconsumedAt ?? nowIso()
          }).where(and(
            eq(postDrafts.id, post.id),
            eq(postDrafts.version, post.version),
            eq(postDrafts.state, post.state)
          )).returning();
          if (updatedPostRow === undefined) {
            throw new Error("Post draft state changed before preview creation completed");
          }
          return {
            outcome: "created",
            post: normalizeRowTimestamps(updatedPostRow),
            preview
          };
        });
      },
      async consumeExact(input: {
        tokenHash: string;
        consumedAt: string;
        expected: PreviewExpectedRow;
        allowedStates: readonly string[];
        claimState?: string;
      }): Promise<PreviewConsumptionResult> {
        const consumedAt = assertIsoTimestamp("preview.consumedAt", input.consumedAt);
        return serializableTransaction(database, async (transaction) => consumePreviewExact(
          transaction,
          { ...input, consumedAt }
        ));
      },
      async consume(tokenHash: string, consumedAt: string): Promise<PostPreview | undefined> {
        assertIsoTimestamp("preview.consumedAt", consumedAt);
        return database.transaction(async (transaction) => {
          const [preview] = await transaction.update(postPreviews).set({ consumedAt }).where(and(
            eq(postPreviews.tokenHash, tokenHash),
            isNull(postPreviews.consumedAt)
          )).returning();
          return preview === undefined ? undefined : normalizeRowTimestamps(preview);
        });
      }
    },
    publishAttemptMedia: {
      async listForAttempt(attemptId: string): Promise<PublishAttemptMedia[]> {
        if (!isUuid(attemptId)) {
          return [];
        }
        const rows = await database.select().from(publishAttemptMedia).where(
          eq(publishAttemptMedia.publishAttemptId, attemptId)
        ).orderBy(asc(publishAttemptMedia.position), asc(publishAttemptMedia.id));
        return normalizeRows(rows);
      },
      async updateState(
        input: PublishAttemptMediaUpdateInput
      ): Promise<PublishAttemptMedia | undefined> {
        if (!isUuid(input.id)) {
          return undefined;
        }
        const conditions = [eq(publishAttemptMedia.id, input.id)];
        if (input.expectedState !== undefined) {
          conditions.push(eq(publishAttemptMedia.state, input.expectedState));
        }
        const [row] = await database.update(publishAttemptMedia).set({
          state: input.state,
          ...(input.linkedinImageUrn === undefined
            ? {}
            : { linkedinImageUrn: input.linkedinImageUrn })
        }).where(and(...conditions)).returning();
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      }
    },
    publishAttempts: {
      record: recordPublishAttempt,
      claimExact: claimExactPublish,
      async transitionToCreatingPost(input: {
        id: string;
        postDraftId: string;
        version: number;
      }): Promise<boolean> {
        if (!isUuid(input.id) || !isUuid(input.postDraftId)) return false;
        return serializableTransaction(database, async (transaction) => {
          const [attempt] = await transaction.update(publishAttempts).set({
            phase: "creating_post"
          }).where(and(
            eq(publishAttempts.id, input.id),
            eq(publishAttempts.postDraftId, input.postDraftId),
            eq(publishAttempts.version, input.version),
            eq(publishAttempts.phase, "uploading_media"),
            eq(publishAttempts.responseCategory, "pending")
          )).returning();
          if (attempt === undefined) return false;
          const [post] = await transaction.update(postDrafts).set({
            state: "publishing",
            updatedAt: nowIso()
          }).where(and(
            eq(postDrafts.id, input.postDraftId),
            eq(postDrafts.version, input.version),
            eq(postDrafts.state, "uploading_media")
          )).returning();
          if (post === undefined) {
            throw new Error("Post draft state changed before final publish phase");
          }
          return true;
        });
      },
      async complete(input: {
        id: string;
        postDraftId: string;
        version: number;
        expectedPhase: "uploading_media" | "creating_post";
        expectedPostState: "uploading_media" | "publishing";
        nextPostState: "media_upload_failed" | "media_upload_unknown" | "published" | "publish_failed" | "publish_unknown";
        responseCategory: "published" | "definite_rejection" | "ambiguous" | "media_definite_rejection" | "media_ambiguous";
        completedAt: string;
        postUrn?: string;
        sanitizedError?: string;
      }): Promise<boolean> {
        const completedAt = assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
        if (!isUuid(input.id) || !isUuid(input.postDraftId)) return false;
        return serializableTransaction(database, async (transaction) => {
          const [attempt] = await transaction.update(publishAttempts).set({
            phase: "complete",
            responseCategory: input.responseCategory,
            completedAt,
            ...(input.postUrn === undefined ? {} : { postUrn: input.postUrn }),
            ...(input.sanitizedError === undefined ? {} : { sanitizedError: input.sanitizedError })
          }).where(and(
            eq(publishAttempts.id, input.id),
            eq(publishAttempts.postDraftId, input.postDraftId),
            eq(publishAttempts.version, input.version),
            eq(publishAttempts.phase, input.expectedPhase),
            eq(publishAttempts.responseCategory, "pending")
          )).returning();
          if (attempt === undefined) return false;
          const [post] = await transaction.update(postDrafts).set({
            state: input.nextPostState,
            updatedAt: completedAt
          }).where(and(
            eq(postDrafts.id, input.postDraftId),
            eq(postDrafts.version, input.version),
            eq(postDrafts.state, input.expectedPostState)
          )).returning();
          if (post === undefined) {
            throw new Error("Post draft state changed before publish completion");
          }
          return true;
        });
      },
      async updateResult(id: string, input: {
        responseCategory: string;
        postUrn?: string;
        sanitizedError?: string;
        completedAt: string;
      }): Promise<PublishAttempt | undefined> {
        assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
        if (!isUuid(id)) {
          return undefined;
        }
        const [attempt] = await database.update(publishAttempts).set({
          responseCategory: input.responseCategory,
          ...(input.postUrn === undefined ? {} : { postUrn: input.postUrn }),
          ...(input.sanitizedError === undefined ? {} : { sanitizedError: input.sanitizedError }),
          completedAt: input.completedAt
        }).where(eq(publishAttempts.id, id)).returning();
        return attempt === undefined ? undefined : normalizeRowTimestamps(attempt);
      },
      async listForPostDraft(postDraftId: string): Promise<PublishAttempt[]> {
        if (!isUuid(postDraftId)) {
          return [];
        }
        const rows = await database.select().from(publishAttempts).where(
          eq(publishAttempts.postDraftId, postDraftId)
        ).orderBy(asc(publishAttempts.requestedAt), asc(publishAttempts.id));
        return normalizeRows(rows);
      }
    },
    oauthTokens: {
      async upsert(input: {
        provider: string;
        ciphertext: string;
        refreshMetadataCiphertext?: string;
        expiresAt?: string;
      }): Promise<OAuthToken> {
        const now = nowIso();
        const expiresAt = input.expiresAt === undefined
          ? undefined
          : assertIsoTimestamp("oauthToken.expiresAt", input.expiresAt);
        await database.insert(oauthTokens).values({
          id: randomUUID(),
          provider: input.provider,
          ciphertext: input.ciphertext,
          ...(input.refreshMetadataCiphertext === undefined
            ? {}
            : { refreshMetadataCiphertext: input.refreshMetadataCiphertext }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: oauthTokens.provider,
          set: {
            ciphertext: input.ciphertext,
            refreshMetadataCiphertext: input.refreshMetadataCiphertext ?? null,
            expiresAt: expiresAt ?? null,
            updatedAt: now
          }
        });
        const [token] = await database.select().from(oauthTokens).where(
          eq(oauthTokens.provider, input.provider)
        );
        return requiredRow(token, "OAuth token");
      },
      async getByProvider(provider: string): Promise<OAuthToken | undefined> {
        const [token] = await database.select().from(oauthTokens).where(
          eq(oauthTokens.provider, provider)
        );
        return token === undefined ? undefined : normalizeRowTimestamps(token);
      }
    }
  };
}
