import { z } from "zod";

const id = z.string().trim().min(1).max(256);
const shortText = z.string().trim().min(1).max(500);
const mediumText = z.string().trim().min(1).max(2_000);

export const visibilitySchema = z.enum(["PUBLIC", "CONNECTIONS"]);
export const pipelineStatusSchema = z.enum([
  "discovered", "shortlisted", "connect_planned", "connected", "contacted", "replied", "archived"
]);

export const preferencesSchema = z.object({
  roleKeywords: z.array(shortText).max(25),
  preferredLocations: z.array(shortText).max(25),
  industries: z.array(shortText).max(25)
}).strict();

export const targetScoreSchema = z.object({
  personId: id,
  companyId: id,
  companyName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  pmmOpportunity: z.number().finite().min(0).max(100),
  referralPotential: z.number().finite().min(0).max(100),
  networkValue: z.number().finite().min(0).max(100),
  total: z.number().finite().min(0).max(100),
  confidence: z.number().finite().min(0).max(1),
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
export const rankNetworkingTargetsInput = z.object({ scores: z.array(targetScoreSchema).max(200) }).strict();
export const explainTargetMatchInput = z.object({ score: targetScoreSchema }).strict();
export const draftOutreachInput = z.object({
  targetId: id,
  purpose: z.string().trim().min(1).max(100),
  text: mediumText,
  evidenceIds: z.array(id).min(1).max(25)
}).strict();
export const draftLinkedInPostInput = z.object({ text: z.string().trim().min(1).max(3_000), visibility: visibilitySchema }).strict();
export const revisePostInput = z.object({ postId: id, text: z.string().trim().min(1).max(3_000) }).strict();
export const previewPostInput = z.object({ postId: id, version: z.number().int().positive() }).strict();
export const createWeeklyShortlistInput = z.object({ name: z.string().trim().min(1).max(120), targetIds: z.array(id).max(100) }).strict();
export const saveTargetInput = z.object({ score: targetScoreSchema }).strict();
export const updateOutreachStatusInput = z.object({ targetId: id, status: pipelineStatusSchema }).strict();
export const listPipelineInput = z.object({ companyId: id.optional(), status: pipelineStatusSchema.optional() }).strict();
export const recordNoteInput = z.object({ targetId: id, text: z.string().trim().min(1).max(4_000) }).strict();
export const listPostHistoryInput = z.object({ postId: id }).strict();
export const emptyInputSchema = z.object({}).strict();
export const publishLinkedInPostInput = z.object({
  postId: id,
  versionId: id,
  version: z.number().int().positive(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  visibility: visibilitySchema
}).strict();

/** Every tool returns either a successful, bounded response envelope or a safe error code. */
export const toolOutputSchema = z.object({
  data: z.record(z.string(), z.unknown())
}).strict();
