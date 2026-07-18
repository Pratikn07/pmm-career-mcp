import { z } from "zod";

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
export const publishLinkedInPostInput = z.object({
  postId: id,
  versionId: id,
  version: z.number().int().positive(),
  checksum,
  previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  visibility: visibilitySchema
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
  "publishing",
  "published",
  "publish_failed",
  "publish_unknown"
]);

const postDraftSchema = z.object({
  id,
  versionId: id,
  text: z.string().max(3_000),
  visibility: visibilitySchema,
  version: z.number().int().positive(),
  checksum,
  state: postStateSchema,
  createdAt: timestamp,
  updatedAt: timestamp
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
    publishingEnabled: z.boolean()
  }).strict()
}).strict());
export const createLinkedInAuthorizationUrlOutput = outputSchema(z.object({
  authorizationUrl: url
}).strict());
export const publishLinkedInPostOutput = outputSchema(z.object({
  result: z.discriminatedUnion("state", [
    z.object({ state: z.literal("published"), postUrn: z.string().regex(/^urn:li:(?:share|ugcPost):[0-9]+$/) }).strict(),
    z.object({ state: z.literal("publish_failed") }).strict(),
    z.object({ state: z.literal("publish_unknown") }).strict()
  ])
}).strict());
