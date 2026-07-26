import { z } from "zod";
import { validateNonFetchingLinkedInProfileUrl } from "../founder-research/profile-url.js";

const id = z.string().trim().min(1).max(256);
const name = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const mediumText = z.string().trim().min(1).max(2_000);
const longText = z.string().max(4_000);
const url = z.string().url().max(2_048);
const timestamp = z.string().datetime({ offset: true });
const confidence = z.number().finite().min(0).max(1);
const scoreComponent = z.number().finite().min(0).max(100);
const checksum = z.string().regex(/^[0-9a-f]{64}$/);
const imageAltText = z.string()
  .refine((value) => {
    const normalized = value.normalize("NFC").trim();
    return [...normalized].length >= 1 && [...normalized].length <= 120;
  }, {
    message: "alt text must contain 1 to 120 Unicode characters"
  })
  .refine((value) => !/[\r\n\u2028\u2029]/u.test(value.normalize("NFC").trim()), {
    message: "alt text must be a single line"
  });

export const visibilitySchema = z.enum(["PUBLIC", "CONNECTIONS"]);
export const pipelineStatusSchema = z.enum([
  "discovered", "shortlisted", "connect_planned", "connected", "contacted", "replied", "archived"
]);

const sourceWarningSchema = z.object({
  code: z.enum([
    "source-failed",
    "source-changed",
    "budget-exhausted",
    "invalid-data",
    "stale-source"
  ]).optional(),
  sourceUrl: url,
  message: shortText
}).strict();

const evidenceSchema = z.object({
  id,
  url,
  sourceUrl: url,
  title: shortText,
  fact: shortText,
  checkedAt: timestamp,
  confidence
}).strict();

const personWithEvidenceSchema = z.object({
  id,
  companyId: id,
  name,
  role: name,
  publicProfileUrl: url.optional(),
  checkedAt: timestamp,
  confidence,
  evidence: z.array(evidenceSchema).max(100)
}).strict();

const opportunitySchema = z.object({
  id,
  companyId: id,
  title: name,
  location: name.optional(),
  sourceUrl: url,
  checkedAt: timestamp,
  active: z.boolean()
}).strict();

const targetEvidenceSchema = z.object({
  activePmmRole: z.boolean().optional(),
  companyHiring: z.boolean().optional(),
  roleSeniority: z.boolean().optional(),
  sharedDomain: z.boolean().optional(),
  locationMatch: z.boolean().optional(),
  recentFundingSignal: z.boolean().optional(),
  companyCheckedAt: timestamp.optional()
}).strict();

export const preferencesSchema = z.object({
  roleKeywords: z.array(shortText).max(25),
  preferredLocations: z.array(shortText).max(25),
  industries: z.array(shortText).max(25)
}).strict();

export const scoreTargetInputSchema = z.object({
  companyName: name,
  person: personWithEvidenceSchema,
  opportunities: z.array(opportunitySchema).max(100),
  preferences: preferencesSchema,
  weights: z.object({
    pmmOpportunity: z.number().finite().min(0).max(1_000_000),
    referralPotential: z.number().finite().min(0).max(1_000_000),
    networkValue: z.number().finite().min(0).max(1_000_000)
  }).strict(),
  evidence: targetEvidenceSchema
}).strict();

export const targetScoreSchema = z.object({
  personId: id,
  companyId: id,
  companyName: name,
  name,
  pmmOpportunity: scoreComponent,
  referralPotential: scoreComponent,
  networkValue: scoreComponent,
  total: scoreComponent,
  confidence,
  reasons: z.array(shortText).max(50),
  missingEvidence: z.array(shortText).max(50)
}).strict();

export const searchYcCompaniesInput = z.object({
  batch: shortText.optional(),
  industry: shortText.optional(),
  status: shortText.optional(),
  location: shortText.optional(),
  keyword: shortText.optional(),
  hiring: z.boolean().optional()
}).strict();

export const discoverPublicPeopleInput = z.object({ companyId: id }).strict();
export const findPmmOpportunitiesInput = z.object({
  companyIds: z.array(id).min(1).max(50),
  preferences: preferencesSchema
}).strict();
export const rankNetworkingTargetsInput = z.object({
  targets: z.array(scoreTargetInputSchema).max(200)
}).strict();
export const explainTargetMatchInput = z.object({ target: scoreTargetInputSchema }).strict();
export const draftOutreachInput = z.object({
  targetId: id,
  purpose: z.string().trim().min(1).max(100),
  text: mediumText,
  evidenceIds: z.array(id).min(1).max(25)
}).strict();
export const draftLinkedInPostInput = z.object({
  text: z.string().trim().min(1).max(3_000),
  visibility: visibilitySchema
}).strict();
export const revisePostInput = z.object({
  postId: id,
  text: z.string().trim().min(1).max(3_000)
}).strict();
export const createBrandedVisualBriefInput = z.object({
  postId: id,
  expectedVersion: z.number().int().positive(),
  coverHook: z.string().trim().min(1).max(72),
  conceptSummary: z.string().trim().min(1).max(500),
  visualMode: z.enum(["EDITORIAL_STATEMENT", "EDITORIAL_METAPHOR"]),
  topicLabel: z.string().trim().min(1).max(24).optional()
}).strict();
export const openAiFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().max(100).optional(),
  file_name: z.string().max(255).optional()
}).strict();
export const renderBrandedLinkedInCoverInput = z.object({
  briefId: id,
  postId: id,
  expectedVersion: z.number().int().positive(),
  sourceImage: openAiFileSchema.optional(),
  altText: imageAltText
}).strict();
export const attachLinkedInPostImagesInput = z.object({
  postId: id,
  expectedVersion: z.number().int().positive(),
  images: z.array(openAiFileSchema).min(1).max(4),
  altTexts: z.array(imageAltText).min(1).max(4)
}).strict().refine((value) => value.images.length === value.altTexts.length, {
  message: "images and altTexts must have equal length",
  path: ["altTexts"]
});
export const setLinkedInPostImagesInput = z.object({
  postId: id,
  expectedVersion: z.number().int().positive(),
  media: z.array(z.object({
    mediaId: id,
    altText: imageAltText
  }).strict()).max(4)
}).strict();
export const openLinkedInReviewCardInput = z.object({
  postId: id,
  version: z.number().int().positive()
}).strict();
export const createExactLinkedInPreviewInput = z.object({
  postId: id,
  version: z.number().int().positive()
}).strict();
export const previewPostInput = z.object({ postId: id, version: z.number().int().positive() }).strict();
export const createWeeklyShortlistInput = z.object({
  name: z.string().trim().min(1).max(120),
  targetIds: z.array(id).max(100)
}).strict();
export const saveTargetInput = z.object({ target: scoreTargetInputSchema }).strict();
export const updateOutreachStatusInput = z.object({ targetId: id, status: pipelineStatusSchema }).strict();
export const listPipelineInput = z.object({ companyId: id.optional(), status: pipelineStatusSchema.optional() }).strict();
export const recordNoteInput = z.object({ targetId: id, text: z.string().trim().min(1).max(4_000) }).strict();
export const listPostHistoryInput = z.object({ postId: id }).strict();
export const emptyInputSchema = z.object({}).strict();
export const publishExactLinkedInPostInput = z.object({
  approvalCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

const companySchema = z.object({
  id,
  ycId: id,
  name,
  batch: name.optional(),
  status: name.optional(),
  location: name.optional(),
  industry: name.optional(),
  description: mediumText.optional(),
  hiring: z.boolean().optional(),
  websiteUrl: url.optional(),
  checkedAt: timestamp,
  sources: z.array(evidenceSchema).max(100),
  warnings: z.array(sourceWarningSchema).max(100)
}).strict();

const coverageSourceSchema = z.object({
  sourceUrl: url,
  checkedAt: timestamp,
  confidence
}).strict();

const companyCoverageSchema = z.object({
  id,
  name,
  checkedAt: timestamp,
  sources: z.array(coverageSourceSchema).max(100),
  coverage: z.literal("authoritative-pages-only")
}).strict();

const pipelineTargetSchema = z.object({
  id,
  personId: id,
  pmmOpportunity: scoreComponent,
  referralPotential: scoreComponent,
  networkValue: scoreComponent,
  totalScore: scoreComponent,
  confidence,
  status: pipelineStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  reasons: z.array(shortText).max(50),
  missingEvidence: z.array(shortText).max(50)
}).strict();

const outreachDraftSchema = z.object({
  id,
  targetId: id,
  purpose: z.string().max(100),
  text: z.string().max(2_000),
  version: z.number().int().positive(),
  evidenceIds: z.array(id).max(25),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

const postStateSchema = z.enum([
  "draft",
  "ready_for_preview",
  "ready_for_review",
  "previewed",
  "uploading_media",
  "publishing",
  "published",
  "media_upload_failed",
  "media_upload_unknown",
  "publish_failed",
  "publish_unknown"
]);

const postDraftMediaSchema = z.object({
  position: z.number().int().min(0).max(3),
  mediaId: id,
  altText: imageAltText,
  sha256: checksum,
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif"]),
  byteSize: z.number().int().min(1).max(20 * 1024 * 1024),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameCount: z.number().int().min(1).max(250),
  originalFilename: z.string().max(255).nullable(),
  createdAt: timestamp
}).strict();

const postDraftSchema = z.object({
  id,
  versionId: id,
  text: z.string().max(3_000),
  visibility: visibilitySchema,
  version: z.number().int().positive(),
  checksum,
  state: postStateSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  media: z.array(postDraftMediaSchema).max(4).default([])
}).strict();

const pmmBrandProfileSchema = z.object({
  version: z.number().int().positive(),
  publicName: name,
  roleLine: name,
  seriesName: name,
  monogram: z.string().trim().min(1).max(12),
  voice: z.object({
    persona: shortText,
    traits: z.array(shortText).max(25),
    neverInventExperience: z.literal(true)
  }).strict(),
  palette: z.object({
    ivory: z.string().regex(/^#[0-9A-F]{6}$/),
    navy: z.string().regex(/^#[0-9A-F]{6}$/),
    copper: z.string().regex(/^#[0-9A-F]{6}$/),
    taupe: z.string().regex(/^#[0-9A-F]{6}$/),
    highlight: z.string().regex(/^#[0-9A-F]{6}$/)
  }).strict(),
  hookRules: z.object({
    minWords: z.number().int().positive(),
    maxWords: z.number().int().positive(),
    maxCharacters: z.number().int().positive().max(72),
    recentWindow: z.number().int().nonnegative().max(100)
  }).strict(),
  recentUsage: z.array(z.object({
    templateId: id,
    coverHook: z.string().max(72),
    createdAt: timestamp
  }).strict()).max(30)
}).strict();

const brandVisualBriefSchema = z.object({
  id,
  postId: id,
  postVersion: z.number().int().positive(),
  profileVersion: z.number().int().positive(),
  templateId: id,
  templateVersion: z.number().int().positive(),
  promptFormatVersion: z.number().int().positive(),
  visualMode: z.enum(["EDITORIAL_STATEMENT", "EDITORIAL_METAPHOR"]),
  coverHook: z.string().max(72),
  conceptSummary: z.string().max(500),
  topicLabel: z.string().max(24).nullable(),
  generationPrompt: z.string().min(1).max(4_000),
  negativeConstraints: z.array(shortText).max(50),
  state: z.enum(["ready", "rendered"]),
  createdAt: timestamp
}).strict();

const brandRenderProvenanceSchema = z.object({
  seriesName: name,
  profileVersion: z.number().int().positive(),
  templateId: id,
  templateVersion: z.number().int().positive(),
  coverHook: z.string().max(72),
  renderChecksum: checksum,
  validationPassed: z.boolean(),
  validation: z.object({
    fixedLabelsPresent: z.boolean(),
    textWithinSafeArea: z.boolean(),
    sourceImageUsed: z.boolean()
  }).strict()
}).strict();

const brandReviewProvenanceSchema = z.object({
  seriesName: name,
  profileVersion: z.number().int().positive(),
  templateId: id,
  templateVersion: z.number().int().positive(),
  coverHook: z.string().max(72),
  renderChecksum: checksum,
  validationPassed: z.boolean()
}).strict();

const previewSchema = z.object({
  postId: id,
  versionId: id,
  text: z.string().max(3_000),
  version: z.number().int().positive(),
  checksum,
  visibility: visibilitySchema,
  characterCount: z.number().int().nonnegative().max(3_000),
  previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: timestamp
}).strict();

const exactPreviewSchema = z.object({
  postId: id,
  versionId: id,
  text: z.string().max(3_000),
  version: z.number().int().positive(),
  checksum,
  visibility: visibilitySchema,
  characterCount: z.number().int().nonnegative().max(3_000),
  media: z.array(postDraftMediaSchema).max(4),
  expiresAt: timestamp
}).strict();

const shortlistEntrySchema = z.object({
  id,
  shortlistId: id,
  targetId: id,
  position: z.number().int().nonnegative().max(99),
  createdAt: timestamp
}).strict();

const shortlistSchema = z.object({
  id,
  name: z.string().max(120),
  createdAt: timestamp,
  updatedAt: timestamp,
  entries: z.array(shortlistEntrySchema).max(100)
}).strict();

const noteSchema = z.object({
  id,
  targetId: id,
  text: longText,
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

const safeErrorDataSchema = z.object({
  error: z.object({
    code: z.enum([
      "VALIDATION_ERROR",
      "INVALID_KEY",
      "INVALID_JSON_VALUE",
      "INVALID_ENVELOPE",
      "DECRYPTION_FAILED",
      "OAUTH_STATE_INVALID",
      "OAUTH_PROVIDER_ERROR",
      "PUBLISH_DISABLED",
      "PREVIEW_INVALID",
      "PREVIEW_EXPIRED",
      "PREVIEW_CONSUMED",
      "PREVIEW_MISMATCH",
      "PREVIEW_STALE",
      "NOT_FOUND",
      "INVALID_TRANSITION",
      "CONFLICT",
      "EVIDENCE_MISMATCH",
      "MEDIA_DOWNLOAD_ERROR",
      "MEDIA_VALIDATION_ERROR",
      "MEDIA_STORAGE_ERROR",
      "AUTH_REQUIRED",
      "DATA_INTEGRITY"
    ])
  }).strict()
}).strict();

function outputSchema<T extends z.ZodType>(success: T) {
  return z.object({ data: z.union([success, safeErrorDataSchema]) }).strict();
}

export const searchYcCompaniesOutput = outputSchema(z.object({
  companies: z.array(companySchema).max(500),
  coverage: z.array(companyCoverageSchema).max(500),
  coverageSummary: z.object({
    coverage: z.literal("authoritative-page-only"),
    complete: z.literal(false),
    sourceUrl: url,
    limitation: mediumText
  }).strict()
}).strict());

export const discoverPublicPeopleOutput = outputSchema(z.object({
  people: z.array(personWithEvidenceSchema).max(500),
  evidence: z.array(evidenceSchema).max(500),
  checkedAt: timestamp,
  coverage: z.enum(["authoritative-pages-only", "search-extended"]),
  warnings: z.array(sourceWarningSchema).max(500)
}).strict());

export const findPmmOpportunitiesOutput = outputSchema(z.object({
  opportunities: z.array(opportunitySchema).max(500),
  checkedAt: timestamp,
  warnings: z.array(sourceWarningSchema).max(500),
  coverage: z.literal("authoritative-pages-only")
}).strict());

export const rankNetworkingTargetsOutput = outputSchema(z.object({
  targets: z.array(targetScoreSchema).max(200)
}).strict());

export const explainTargetMatchOutput = outputSchema(z.object({
  score: targetScoreSchema,
  reasons: z.array(shortText).max(50),
  missingEvidence: z.array(shortText).max(50)
}).strict());

export const draftOutreachOutput = outputSchema(z.object({ draft: outreachDraftSchema }).strict());
export const draftLinkedInPostOutput = outputSchema(z.object({ post: postDraftSchema }).strict());
export const revisePostOutput = outputSchema(z.object({ post: postDraftSchema }).strict());
export const getPmmBrandProfileOutput = outputSchema(z.object({
  profile: pmmBrandProfileSchema
}).strict());
export const createBrandedVisualBriefOutput = outputSchema(z.object({
  brief: brandVisualBriefSchema,
  requiresSourceImage: z.boolean(),
  proposedAltText: imageAltText
}).strict());
export const renderBrandedLinkedInCoverOutput = outputSchema(z.object({
  post: postDraftSchema,
  provenance: brandRenderProvenanceSchema
}).strict());
export const attachLinkedInPostImagesOutput = outputSchema(z.object({ post: postDraftSchema }).strict());
export const setLinkedInPostImagesOutput = outputSchema(z.object({ post: postDraftSchema }).strict());
export const openLinkedInReviewCardOutput = outputSchema(z.object({
  post: postDraftSchema,
  brand: brandReviewProvenanceSchema.optional()
}).strict());
export const createExactLinkedInPreviewOutput = outputSchema(z.object({
  preview: exactPreviewSchema
}).strict());
export const previewPostOutput = outputSchema(z.object({ preview: previewSchema }).strict());
export const createWeeklyShortlistOutput = outputSchema(z.object({ shortlist: shortlistSchema }).strict());
export const saveTargetOutput = outputSchema(z.object({ target: pipelineTargetSchema }).strict());
export const updateOutreachStatusOutput = outputSchema(z.object({ target: pipelineTargetSchema }).strict());
export const listPipelineOutput = outputSchema(z.object({ targets: z.array(pipelineTargetSchema).max(500) }).strict());
export const recordNoteOutput = outputSchema(z.object({ note: noteSchema }).strict());
export const listPostHistoryOutput = outputSchema(z.object({ posts: z.array(postDraftSchema).max(500) }).strict());
export const getLinkedInConnectionStatusOutput = outputSchema(z.object({
  connection: z.object({
    connected: z.boolean(),
    valid: z.boolean(),
    publishingEnabled: z.boolean(),
    imagePublishingEnabled: z.boolean()
  }).strict()
}).strict());
export const createLinkedInAuthorizationUrlOutput = outputSchema(z.object({
  authorizationUrl: url
}).strict());
export const publishExactLinkedInPostOutput = outputSchema(z.object({
  result: z.discriminatedUnion("state", [
    z.object({ state: z.literal("published"), postUrn: z.string().regex(/^urn:li:(?:share|ugcPost):[0-9]+$/) }).strict(),
    z.object({ state: z.literal("media_upload_failed") }).strict(),
    z.object({ state: z.literal("media_upload_unknown") }).strict(),
    z.object({ state: z.literal("publish_failed") }).strict(),
    z.object({ state: z.literal("publish_unknown") }).strict()
  ])
}).strict());

const founderResearchId = z.string().uuid();
const founderResearchRunState = z.enum([
  "PENDING", "RUNNING", "NEEDS_PUBLIC_SEARCH", "COMPLETE", "PARTIAL", "FAILED"
]);
const founderResearchItemState = z.enum([
  "COMPLETE", "PARTIAL", "NOT_FOUND", "AMBIGUOUS", "NEEDS_PUBLIC_SEARCH", "FAILED", "STALE_ATTEMPT"
]);
const founderProfileStatus = z.enum(["VERIFIED", "CANDIDATE", "CONFIRMED", "REJECTED"]);
const founderCandidateProfileUrl = z.string().url().max(4_096).superRefine((value, context) => {
  if (!validateNonFetchingLinkedInProfileUrl(value).ok) {
    context.addIssue({ code: "custom", message: "must be a safe non-fetching LinkedIn profile URL" });
  }
});

function unicodeText(maximum: number) {
  return z.string().trim().min(1).refine((value) => [...value.normalize("NFC")].length <= maximum, {
    message: `must contain at most ${maximum} Unicode characters`
  });
}

function boundedUnicodeText(maximum: number, maximumBytes: number) {
  return unicodeText(maximum).refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes, {
    message: `must contain at most ${maximumBytes} UTF-8 bytes`
  });
}
const founderRunSchema = z.object({
  id: founderResearchId,
  state: founderResearchRunState,
  requestedLimit: z.number().int().min(1).max(50),
  selectedCount: z.number().int().min(0).max(50),
  processedCount: z.number().int().min(0).max(50),
  completeCount: z.number().int().min(0).max(50),
  partialCount: z.number().int().min(0).max(50),
  ambiguousCount: z.number().int().min(0).max(50),
  notFoundCount: z.number().int().min(0).max(50),
  failedCount: z.number().int().min(0).max(50),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  updatedAt: timestamp
}).strict();
const founderCandidateSchema = z.object({
  id: founderResearchId,
  runPersonId: founderResearchId,
  profileUrl: founderCandidateProfileUrl,
  status: founderProfileStatus,
  sourceKind: z.enum(["OFFICIAL_YC", "OFFICIAL_COMPANY", "PUBLIC_SEARCH", "MANUAL_CONFIRMATION"]),
  searchQuery: z.string().min(1).max(500).nullable(),
  evidenceUrl: url,
  evidenceTitle: z.string().min(1).max(512).nullable(),
  evidenceSnippet: z.string().min(1).max(2_000).nullable(),
  checkedAt: timestamp,
  confidence,
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();
const founderCandidateResultSchema = z.object({
  candidate: founderCandidateSchema,
  canonical: founderCandidateSchema.optional(),
  requiresManualReview: z.boolean()
}).strict();

export const startYcFounderResearchInput = z.object({
  batch: z.string().trim().min(1).max(80).optional(),
  industry: z.string().trim().min(1).max(160).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  location: z.string().trim().min(1).max(160).optional(),
  keyword: z.string().trim().min(1).max(240).optional(),
  hiring: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).default(50)
}).strict();
export const processYcFounderResearchInput = z.object({
  runId: founderResearchId,
  maxCompanies: z.number().int().min(1).max(5).default(5)
}).strict();
const founderProfileCandidateInput = z.object({
  runItemId: founderResearchId,
  runPersonId: founderResearchId.optional(),
  founderName: boundedUnicodeText(200, 512),
  founderRole: boundedUnicodeText(160, 512),
  candidateProfileUrl: founderCandidateProfileUrl,
  searchQuery: boundedUnicodeText(500, 2_000),
  resultUrl: founderCandidateProfileUrl,
  resultTitle: boundedUnicodeText(512, 1_024).optional(),
  resultSnippet: boundedUnicodeText(2_000, 4_000).optional(),
  checkedAt: timestamp,
  confidence,
  linkedInNotFetched: z.literal(true)
}).strict().refine((value) => value.resultTitle !== undefined || value.resultSnippet !== undefined, {
  message: "resultTitle or resultSnippet is required"
}).refine((value) => (
  (() => {
    const profile = validateNonFetchingLinkedInProfileUrl(value.candidateProfileUrl);
    const result = validateNonFetchingLinkedInProfileUrl(value.resultUrl);
    return profile.ok && result.ok && profile.value === result.value;
  })()
), { message: "resultUrl must match candidateProfileUrl" });
export const saveFounderProfileCandidatesInput = z.object({
  runId: founderResearchId,
  candidates: z.array(founderProfileCandidateInput).min(1).max(25)
}).strict();
export const confirmFounderProfileCandidateInput = z.object({
  candidateId: founderResearchId,
  decision: z.enum(["CONFIRM", "REJECT"]),
  note: boundedUnicodeText(1_000, 2_000).optional()
}).strict();
const founderOutreachEntryInput = z.object({
  personId: founderResearchId,
  pmmOpportunity: scoreComponent,
  referralPotential: scoreComponent,
  networkValue: scoreComponent,
  total: scoreComponent,
  confidence,
  reasons: z.array(shortText).max(50),
  missingEvidence: z.array(shortText).max(50),
  evidenceIds: z.array(founderResearchId).max(25),
  personalizationClaims: z.array(z.object({
    text: z.string().trim().min(1).max(500),
    evidenceIds: z.array(founderResearchId).min(1).max(25)
  }).strict()).max(25),
  text: unicodeText(200),
  reviewState: z.enum(["READY_TO_REVIEW", "NEEDS_REVIEW"]).optional()
}).strict();
export const saveFounderOutreachBatchInput = z.object({
  runId: founderResearchId,
  requestId: z.string().trim().min(1).max(200),
  entries: z.array(founderOutreachEntryInput).min(1).max(25)
}).strict();
export const exportFounderResearchWorkbookInput = z.object({
  runId: founderResearchId,
  includeCandidateUrls: z.literal(true).default(true)
}).strict();

export const startYcFounderResearchOutput = outputSchema(z.object({
  run: founderRunSchema,
  selectedCompanyIds: z.array(founderResearchId).max(50),
  nextAction: z.literal("PROCESS")
}).strict());
const founderProcessedItemSchema = z.object({
  runItemId: founderResearchId,
  companyId: founderResearchId,
  leaseAttempt: z.number().int().min(0).max(100),
  state: founderResearchItemState,
  founderCount: z.number().int().min(0).max(50),
  verifiedProfileCount: z.number().int().min(0).max(50),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).optional(),
  errorSummary: z.string().trim().min(1).max(240).optional()
}).strict();
const founderPublicSearchTaskSchema = z.object({
  runItemId: founderResearchId,
  companyId: founderResearchId,
  companyName: z.string().trim().min(1).max(200),
  officialWebsiteUrl: url.optional(),
  knownPersonId: founderResearchId.optional(),
  knownFounderName: z.string().trim().min(1).max(200).optional(),
  knownFounderRole: z.string().trim().min(1).max(160).optional(),
  suggestedQueries: z.array(z.string().trim().min(1).max(500)).max(5),
  reason: z.enum(["PROFILE_URL_MISSING", "FOUNDER_NOT_FOUND", "AMBIGUOUS"])
}).strict();
export const processYcFounderResearchOutput = outputSchema(z.object({
  run: founderRunSchema,
  leasedCount: z.number().int().min(0).max(5),
  items: z.array(founderProcessedItemSchema).max(5),
  publicSearchTasks: z.array(founderPublicSearchTaskSchema).max(25),
  shouldContinue: z.boolean(),
  nextAction: z.enum(["PROCESS", "PUBLIC_SEARCH", "EXPORT"])
}).strict());
const founderCandidateFailureSchema = z.object({
  index: z.number().int().min(0).max(24),
  runItemId: founderResearchId,
  state: z.literal("FAILED"),
  error: z.object({
    code: z.enum([
      "VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "EVIDENCE_MISMATCH",
      "AUTH_REQUIRED", "DATA_INTEGRITY"
    ])
  }).strict()
}).strict();
const founderCandidateSavedSchema = founderCandidateResultSchema.extend({
  index: z.number().int().min(0).max(24),
  runItemId: founderResearchId,
  state: z.literal("SAVED")
});
export const saveFounderProfileCandidatesOutput = outputSchema(z.object({
  results: z.array(z.discriminatedUnion("state", [
    founderCandidateSavedSchema,
    founderCandidateFailureSchema
  ])).max(25)
}).strict());
export const confirmFounderProfileCandidateOutput = outputSchema(founderCandidateResultSchema);
const founderOutreachDraftSchema = z.object({
  personId: founderResearchId,
  targetId: founderResearchId,
  draftId: founderResearchId,
  version: z.number().int().positive(),
  purpose: z.literal("linkedin_connection_request"),
  text: unicodeText(200),
  evidenceIds: z.array(founderResearchId).max(25)
}).strict();
export const saveFounderOutreachBatchOutput = outputSchema(z.object({
  drafts: z.array(founderOutreachDraftSchema).max(25),
  needsVerification: z.array(z.object({
    personId: founderResearchId,
    reason: z.literal("PROFILE_NOT_CONFIRMED")
  }).strict()).max(25)
}).strict());
export const exportFounderResearchWorkbookOutput = outputSchema(z.object({
  export: z.object({
    id: founderResearchId,
    runId: founderResearchId,
    createdAt: timestamp,
    expiresAt: timestamp,
    rowCount: z.number().int().nonnegative().max(500),
    sheetCount: z.literal(4),
    checksumSha256: checksum
  }).strict()
}).strict());
