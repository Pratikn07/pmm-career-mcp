import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const careerMcp = pgSchema("career_mcp");

const timestamptz = (name: string) => timestamp(name, {
  mode: "string",
  withTimezone: true
});

export const settings = careerMcp.table("settings", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull().unique(),
  valueJson: jsonb("value_json").$type<unknown>().notNull(),
  updatedAt: timestamptz("updated_at").notNull()
});

export const companies = careerMcp.table("companies", {
  id: uuid("id").primaryKey(),
  ycId: text("yc_id").notNull().unique(),
  name: text("name").notNull(),
  batch: text("batch"),
  status: text("status"),
  websiteUrl: text("website_url"),
  ycUrl: text("yc_url"),
  location: text("location"),
  industry: text("industry"),
  isHiring: boolean("is_hiring"),
  checkedAt: timestamptz("checked_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
});

export const people = careerMcp.table("people", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  publicProfileUrl: text("public_profile_url"),
  checkedAt: timestamptz("checked_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  uniqueIndex("people_company_name_role_unique").on(table.companyId, table.name, table.role)
]);

export const evidence = careerMcp.table("evidence", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => people.id),
  sourceUrl: text("source_url").notNull(),
  title: text("title"),
  factType: text("fact_type"),
  fact: text("fact").notNull(),
  checkedAt: timestamptz("checked_at").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  index("evidence_person_id_idx").on(table.personId),
  check(
    "evidence_confidence_range_check",
    sql`${table.confidence} >= 0 and ${table.confidence} <= 1`
  )
]);

export const targets = careerMcp.table("targets", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => people.id).unique(),
  pmmOpportunity: doublePrecision("pmm_opportunity").notNull(),
  referralPotential: doublePrecision("referral_potential").notNull(),
  networkValue: doublePrecision("network_value").notNull(),
  totalScore: doublePrecision("total_score").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  status: text("status").notNull(),
  rationale: text("rationale").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  check(
    "targets_pmm_opportunity_range_check",
    sql`${table.pmmOpportunity} >= 0 and ${table.pmmOpportunity} <= 100`
  ),
  check(
    "targets_referral_potential_range_check",
    sql`${table.referralPotential} >= 0 and ${table.referralPotential} <= 100`
  ),
  check(
    "targets_network_value_range_check",
    sql`${table.networkValue} >= 0 and ${table.networkValue} <= 100`
  ),
  check(
    "targets_total_score_range_check",
    sql`${table.totalScore} >= 0 and ${table.totalScore} <= 100`
  ),
  check(
    "targets_confidence_range_check",
    sql`${table.confidence} >= 0 and ${table.confidence} <= 1`
  ),
  check(
    "targets_status_check",
    sql`${table.status} in (
      'discovered',
      'shortlisted',
      'connect_planned',
      'connected',
      'contacted',
      'replied',
      'archived'
    )`
  )
]);

export const targetNotes = careerMcp.table("target_notes", {
  id: uuid("id").primaryKey(),
  targetId: uuid("target_id").notNull().references(() => targets.id),
  text: text("text").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  index("target_notes_target_id_idx").on(table.targetId)
]);

export const outreachDrafts = careerMcp.table("outreach_drafts", {
  id: uuid("id").primaryKey(),
  targetId: uuid("target_id").notNull().references(() => targets.id),
  purpose: text("purpose").notNull(),
  text: text("text").notNull(),
  version: integer("version").notNull(),
  evidenceIdsJson: jsonb("evidence_ids_json").$type<string[]>().notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  uniqueIndex("outreach_target_purpose_version_unique").on(
    table.targetId,
    table.purpose,
    table.version
  ),
  check("outreach_drafts_version_check", sql`${table.version} >= 1`)
]);

export const shortlists = careerMcp.table("shortlists", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
});

export const shortlistEntries = careerMcp.table("shortlist_entries", {
  id: uuid("id").primaryKey(),
  shortlistId: uuid("shortlist_id").notNull().references(() => shortlists.id),
  targetId: uuid("target_id").notNull().references(() => targets.id),
  position: integer("position").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  uniqueIndex("shortlist_target_unique").on(table.shortlistId, table.targetId),
  uniqueIndex("shortlist_position_unique").on(table.shortlistId, table.position),
  index("shortlist_entries_target_id_idx").on(table.targetId),
  check("shortlist_entries_position_check", sql`${table.position} >= 0`)
]);

export const brandProfiles = careerMcp.table("brand_profiles", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull(),
  publicName: text("public_name").notNull(),
  roleLine: text("role_line").notNull(),
  seriesName: text("series_name").notNull(),
  monogram: text("monogram").notNull(),
  voiceJson: jsonb("voice_json").$type<Record<string, unknown>>().notNull(),
  paletteJson: jsonb("palette_json").$type<Record<string, string>>().notNull(),
  hookRulesJson: jsonb("hook_rules_json").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  unique("brand_profiles_row_version_unique").on(table.id, table.version),
  unique("brand_profiles_owner_version_unique").on(table.ownerSubject, table.version),
  uniqueIndex("brand_profiles_one_active_owner_unique")
    .on(table.ownerSubject)
    .where(sql`${table.state} = 'active'`),
  check("brand_profiles_version_check", sql`${table.version} >= 1`),
  check("brand_profiles_state_check", sql`${table.state} in ('active','retired')`)
]);

export const postMedia = careerMcp.table("post_media", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  objectPath: text("object_path").notNull(),
  sha256: text("sha256").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  frameCount: integer("frame_count").notNull().default(1),
  originalFilename: text("original_filename"),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  uniqueIndex("post_media_owner_sha_unique").on(table.ownerSubject, table.sha256),
  uniqueIndex("post_media_object_path_unique").on(table.objectPath),
  check("post_media_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check(
    "post_media_mime_check",
    sql`${table.mimeType} in ('image/jpeg','image/png','image/gif')`
  ),
  check("post_media_size_check", sql`${table.byteSize} between 1 and 20971520`),
  check(
    "post_media_dimensions_check",
    sql`${table.width} > 0 and ${table.height} > 0 and (${table.width}::bigint * ${table.height}::bigint) < 36152320`
  ),
  check("post_media_frames_check", sql`${table.frameCount} between 1 and 250`)
]);

export const mediaUsageClaims = careerMcp.table("media_usage_claims", {
  mediaId: uuid("media_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  purpose: text("purpose").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  primaryKey({
    name: "media_usage_claims_pkey",
    columns: [table.mediaId]
  }),
  foreignKey({
    name: "media_usage_claims_media_id_fk",
    columns: [table.mediaId],
    foreignColumns: [postMedia.id]
  }).onDelete("cascade"),
  index("media_usage_claims_owner_subject_idx").on(table.ownerSubject),
  check(
    "media_usage_claims_purpose_check",
    sql`${table.purpose} in ('attached','brand_source')`
  )
]);

export const runtimeRoleOwners = careerMcp.table("runtime_role_owners", {
  roleName: text("role_name").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull().unique(),
  createdAt: timestamptz("created_at").notNull()
});

export const postDraftOwners = careerMcp.table("post_draft_owners", {
  draftId: uuid("draft_id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  unique("post_draft_owners_draft_owner_unique")
    .on(table.draftId, table.ownerSubject),
  index("post_draft_owners_owner_subject_idx").on(table.ownerSubject)
]);

export const postDrafts = careerMcp.table("post_drafts", {
  id: uuid("id").primaryKey(),
  draftId: uuid("draft_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  text: text("text").notNull(),
  visibility: text("visibility").notNull(),
  version: integer("version").notNull(),
  checksum: text("checksum").notNull(),
  state: text("state").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  foreignKey({
    name: "post_drafts_owner_fk",
    columns: [table.draftId, table.ownerSubject],
    foreignColumns: [postDraftOwners.draftId, postDraftOwners.ownerSubject]
  }),
  index("post_drafts_owner_idx").on(table.draftId, table.ownerSubject),
  unique("post_draft_version_unique").on(table.draftId, table.version),
  unique("post_draft_row_version_unique").on(table.id, table.version),
  check("post_drafts_version_check", sql`${table.version} >= 1`),
  check(
    "post_drafts_visibility_check",
    sql`${table.visibility} in ('PUBLIC', 'CONNECTIONS')`
  ),
  check(
    "post_drafts_state_check",
    sql`${table.state} in (
      'draft',
      'ready_for_preview',
      'ready_for_review',
      'previewed',
      'uploading_media',
      'publishing',
      'published',
      'media_upload_failed',
      'media_upload_unknown',
      'publish_failed',
      'publish_unknown'
    )`
  )
]);

export const brandVisualBriefs = careerMcp.table("brand_visual_briefs", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  postDraftId: uuid("post_draft_id").notNull(),
  postVersion: integer("post_version").notNull(),
  brandProfileId: uuid("brand_profile_id").notNull(),
  brandProfileVersion: integer("brand_profile_version").notNull(),
  templateId: text("template_id").notNull(),
  templateVersion: integer("template_version").notNull(),
  promptFormatVersion: integer("prompt_format_version").notNull(),
  visualMode: text("visual_mode").notNull(),
  coverHook: text("cover_hook").notNull(),
  conceptSummary: text("concept_summary").notNull(),
  topicLabel: text("topic_label"),
  generationPrompt: text("generation_prompt").notNull(),
  negativeConstraintsJson: jsonb("negative_constraints_json").$type<string[]>().notNull(),
  state: text("state").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  foreignKey({
    name: "brand_visual_briefs_post_version_fk",
    columns: [table.postDraftId, table.postVersion],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  foreignKey({
    name: "brand_visual_briefs_profile_version_fk",
    columns: [table.brandProfileId, table.brandProfileVersion],
    foreignColumns: [brandProfiles.id, brandProfiles.version]
  }),
  index("brand_visual_briefs_post_version_idx").on(table.postDraftId, table.postVersion),
  index("brand_visual_briefs_profile_version_idx")
    .on(table.brandProfileId, table.brandProfileVersion),
  index("brand_visual_briefs_owner_created_idx").on(table.ownerSubject, table.createdAt),
  check("brand_visual_briefs_mode_check",
    sql`${table.visualMode} in ('EDITORIAL_STATEMENT','EDITORIAL_METAPHOR')`),
  check("brand_visual_briefs_state_check", sql`${table.state} in ('ready','rendered')`)
]);

export const brandBriefSourceClaims = careerMcp.table("brand_brief_source_claims", {
  briefId: uuid("brief_id").primaryKey().references(
    () => brandVisualBriefs.id,
    { onDelete: "cascade" }
  ),
  ownerSubject: uuid("owner_subject").notNull(),
  postDraftId: uuid("post_draft_id").notNull(),
  postVersion: integer("post_version").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  foreignKey({
    name: "brand_brief_source_claims_post_version_fk",
    columns: [table.postDraftId, table.postVersion],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  index("brand_brief_source_claims_owner_subject_idx").on(table.ownerSubject),
  index("brand_brief_source_claims_post_version_idx")
    .on(table.postDraftId, table.postVersion)
]);

export const brandVisualRenders = careerMcp.table("brand_visual_renders", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  briefId: uuid("brief_id").notNull().references(() => brandVisualBriefs.id),
  version: integer("version").notNull(),
  sourceMediaId: uuid("source_media_id").references(() => postMedia.id),
  renderedMediaId: uuid("rendered_media_id").notNull().references(() => postMedia.id),
  altText: text("alt_text").notNull(),
  renderChecksum: text("render_checksum").notNull(),
  rendererVersion: integer("renderer_version").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  unique("brand_visual_renders_brief_version_unique").on(table.briefId, table.version),
  index("brand_visual_renders_brief_id_idx").on(table.briefId),
  index("brand_visual_renders_source_media_id_idx").on(table.sourceMediaId),
  index("brand_visual_renders_rendered_media_id_idx").on(table.renderedMediaId),
  check("brand_visual_renders_version_check", sql`${table.version} >= 1`),
  check("brand_visual_renders_renderer_version_check", sql`${table.rendererVersion} >= 1`),
  check("brand_visual_renders_checksum_check",
    sql`${table.renderChecksum} ~ '^[0-9a-f]{64}$'`),
  check("brand_visual_renders_alt_text_check",
    sql`char_length(${table.altText}) between 1 and 120`)
]);

export const postDraftMedia = careerMcp.table("post_draft_media", {
  postDraftId: uuid("post_draft_id").notNull(),
  version: integer("version").notNull(),
  position: integer("position").notNull(),
  mediaId: uuid("media_id").notNull(),
  altText: text("alt_text").notNull()
}, (table) => [
  primaryKey({
    name: "post_draft_media_pkey",
    columns: [table.postDraftId, table.version, table.position]
  }),
  unique("post_draft_media_version_media_unique").on(
    table.postDraftId,
    table.version,
    table.mediaId
  ),
  foreignKey({
    name: "post_draft_media_exact_version_fk",
    columns: [table.postDraftId, table.version],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  foreignKey({
    name: "post_draft_media_media_id_fk",
    columns: [table.mediaId],
    foreignColumns: [postMedia.id]
  }),
  index("post_draft_media_media_id_idx").on(table.mediaId),
  check("post_draft_media_position_check", sql`${table.position} between 0 and 3`),
  check(
    "post_draft_media_alt_text_check",
    sql`char_length(${table.altText}) between 1 and 120`
  )
]);

export const postPreviews = careerMcp.table("post_previews", {
  id: uuid("id").primaryKey(),
  postDraftId: uuid("post_draft_id").notNull(),
  version: integer("version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  snapshotChecksum: text("snapshot_checksum"),
  expiresAt: timestamptz("expires_at").notNull(),
  consumedAt: timestamptz("consumed_at")
}, (table) => [
  foreignKey({
    name: "post_previews_exact_version_fk",
    columns: [table.postDraftId, table.version],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  index("post_previews_post_draft_version_idx").on(table.postDraftId, table.version)
]);

export const publishAttempts = careerMcp.table("publish_attempts", {
  id: uuid("id").primaryKey(),
  postDraftId: uuid("post_draft_id").notNull(),
  version: integer("version").notNull(),
  requestedAt: timestamptz("requested_at").notNull(),
  phase: text("phase").notNull().default("preflight"),
  mediaCount: integer("media_count").notNull().default(0),
  responseCategory: text("response_category").notNull(),
  postUrn: text("post_urn"),
  sanitizedError: text("sanitized_error"),
  completedAt: timestamptz("completed_at")
}, (table) => [
  foreignKey({
    name: "publish_attempts_exact_version_fk",
    columns: [table.postDraftId, table.version],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  index("publish_attempts_post_draft_version_idx").on(table.postDraftId, table.version),
  check(
    "publish_attempts_response_category_check",
    sql`${table.responseCategory} in (
      'pending',
      'published',
      'definite_rejection',
      'ambiguous',
      'media_definite_rejection',
      'media_ambiguous'
    )`
  ),
  check(
    "publish_attempts_phase_check",
    sql`${table.phase} in ('preflight','uploading_media','creating_post','complete')`
  ),
  check(
    "publish_attempts_media_count_check",
    sql`${table.mediaCount} between 0 and 4`
  )
]);

export const publishAttemptMedia = careerMcp.table("publish_attempt_media", {
  id: uuid("id").primaryKey(),
  publishAttemptId: uuid("publish_attempt_id").notNull(),
  mediaId: uuid("media_id").notNull(),
  position: integer("position").notNull(),
  state: text("state").notNull().default("pending"),
  linkedinImageUrn: text("linkedin_image_urn")
}, (table) => [
  foreignKey({
    name: "publish_attempt_media_publish_attempt_id_fk",
    columns: [table.publishAttemptId],
    foreignColumns: [publishAttempts.id]
  }),
  foreignKey({
    name: "publish_attempt_media_media_id_fk",
    columns: [table.mediaId],
    foreignColumns: [postMedia.id]
  }),
  unique("publish_attempt_media_position_unique").on(
    table.publishAttemptId,
    table.position
  ),
  index("publish_attempt_media_publish_attempt_id_idx").on(table.publishAttemptId),
  index("publish_attempt_media_media_id_idx").on(table.mediaId),
  check(
    "publish_attempt_media_state_check",
    sql`${table.state} in ('pending','initialized','uploaded','definite_failure','unknown')`
  )
]);

export const oauthTokens = careerMcp.table("oauth_tokens", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  refreshMetadataCiphertext: text("refresh_metadata_ciphertext"),
  expiresAt: timestamptz("expires_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
});

export const schema = {
  settings,
  companies,
  people,
  evidence,
  targets,
  targetNotes,
  outreachDrafts,
  shortlists,
  shortlistEntries,
  brandProfiles,
  postMedia,
  mediaUsageClaims,
  runtimeRoleOwners,
  postDraftOwners,
  postDrafts,
  brandVisualBriefs,
  brandBriefSourceClaims,
  brandVisualRenders,
  postDraftMedia,
  postPreviews,
  publishAttempts,
  publishAttemptMedia,
  oauthTokens
};
