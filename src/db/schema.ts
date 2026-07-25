import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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

const privateBytea = customType<{
  data: Buffer | Uint8Array;
  driverData: Uint8Array;
}>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("Private bytea values must be a Buffer or Uint8Array");
    }
    return value;
  },
  fromDriver(value) {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("Private bytea driver values must be a Buffer or Uint8Array");
    }
    return value;
  }
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
  requestId: text("request_id"),
  requestPayloadHash: text("request_payload_hash"),
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
  uniqueIndex("outreach_target_purpose_request_id_unique").on(
    table.targetId,
    table.purpose,
    table.requestId
  ),
  check("outreach_drafts_version_check", sql`${table.version} >= 1`),
  check(
    "outreach_drafts_request_identity_check",
    sql`(
      (${table.requestId} is null and ${table.requestPayloadHash} is null)
      or (
        ${table.requestId} is not null
        and ${table.requestPayloadHash} is not null
        and ${table.requestPayloadHash} ~ '^[0-9a-f]{64}$'
      )
    )`
  )
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

export const founderResearchRuns = careerMcp.table("founder_research_runs", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  state: text("state").notNull(),
  queryJson: jsonb("query_json").$type<Record<string, unknown>>().notNull(),
  requestedLimit: integer("requested_limit").notNull(),
  selectedCount: integer("selected_count").notNull().default(0),
  processedCount: integer("processed_count").notNull().default(0),
  completeCount: integer("complete_count").notNull().default(0),
  partialCount: integer("partial_count").notNull().default(0),
  ambiguousCount: integer("ambiguous_count").notNull().default(0),
  notFoundCount: integer("not_found_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  createdAt: timestamptz("created_at").notNull(),
  startedAt: timestamptz("started_at"),
  completedAt: timestamptz("completed_at"),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  unique("founder_research_runs_id_owner_unique").on(table.id, table.ownerSubject),
  index("founder_research_runs_owner_subject_idx").on(table.ownerSubject),
  check(
    "founder_research_runs_state_check",
    sql`${table.state} in (
      'PENDING',
      'RUNNING',
      'NEEDS_PUBLIC_SEARCH',
      'COMPLETE',
      'PARTIAL',
      'FAILED'
    )`
  ),
  check(
    "founder_research_runs_requested_limit_check",
    sql`${table.requestedLimit} between 1 and 50`
  ),
  check(
    "founder_research_runs_counts_check",
    sql`
      ${table.selectedCount} between 0 and ${table.requestedLimit}
      and ${table.processedCount} between 0 and ${table.selectedCount}
      and ${table.completeCount} >= 0
      and ${table.partialCount} >= 0
      and ${table.ambiguousCount} >= 0
      and ${table.notFoundCount} >= 0
      and ${table.failedCount} >= 0
      and (
        ${table.completeCount}
        + ${table.partialCount}
        + ${table.ambiguousCount}
        + ${table.notFoundCount}
        + ${table.failedCount}
      ) <= ${table.processedCount}
    `
  ),
  check(
    "founder_research_runs_timestamps_check",
    sql`
      ${table.updatedAt} >= ${table.createdAt}
      and (${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt})
      and (
        ${table.completedAt} is null
        or (
          ${table.completedAt} >= ${table.createdAt}
          and (${table.startedAt} is null or ${table.completedAt} >= ${table.startedAt})
        )
      )
    `
  )
]);

export const founderResearchRunItems = careerMcp.table("founder_research_run_items", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  companyId: uuid("company_id").notNull(),
  state: text("state").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  leaseExpiresAt: timestamptz("lease_expires_at"),
  errorCode: text("error_code"),
  errorSummary: text("error_summary"),
  errorDetailJson: jsonb("error_detail_json").$type<Record<string, unknown>>(),
  checkedAt: timestamptz("checked_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  unique("founder_research_run_items_id_owner_unique").on(table.id, table.ownerSubject),
  foreignKey({
    name: "founder_research_run_items_run_owner_fk",
    columns: [table.runId, table.ownerSubject],
    foreignColumns: [founderResearchRuns.id, founderResearchRuns.ownerSubject]
  }),
  foreignKey({
    name: "founder_research_run_items_company_id_fk",
    columns: [table.companyId],
    foreignColumns: [companies.id]
  }),
  unique("founder_research_run_items_run_company_unique")
    .on(table.runId, table.companyId),
  index("founder_research_run_items_run_owner_idx")
    .on(table.runId, table.ownerSubject),
  index("founder_research_run_items_company_id_idx").on(table.companyId),
  index("founder_research_run_items_owner_subject_idx").on(table.ownerSubject),
  check(
    "founder_research_run_items_state_check",
    sql`${table.state} in (
      'PENDING',
      'LEASED',
      'NEEDS_PUBLIC_SEARCH',
      'COMPLETE',
      'PARTIAL',
      'NOT_FOUND',
      'AMBIGUOUS',
      'FAILED'
    )`
  ),
  check(
    "founder_research_run_items_attempt_count_check",
    sql`${table.attemptCount} >= 0`
  ),
  check(
    "founder_research_run_items_error_bounds_check",
    sql`
      (${table.errorCode} is null or char_length(${table.errorCode}) between 1 and 128)
      and (
        ${table.errorSummary} is null
        or char_length(${table.errorSummary}) between 1 and 1000
      )
    `
  ),
  check(
    "founder_research_run_items_timestamps_check",
    sql`
      ${table.updatedAt} >= ${table.createdAt}
      and (${table.checkedAt} is null or ${table.checkedAt} >= ${table.createdAt})
    `
  )
]);

export const founderResearchRunPeople = careerMcp.table("founder_research_run_people", {
  id: uuid("id").primaryKey(),
  runItemId: uuid("run_item_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  personId: uuid("person_id").notNull(),
  identityStatus: text("identity_status").notNull(),
  founderRoleMatch: text("founder_role_match").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  unique("founder_research_run_people_id_owner_unique")
    .on(table.id, table.ownerSubject),
  foreignKey({
    name: "founder_research_run_people_run_item_owner_fk",
    columns: [table.runItemId, table.ownerSubject],
    foreignColumns: [founderResearchRunItems.id, founderResearchRunItems.ownerSubject]
  }),
  foreignKey({
    name: "founder_research_run_people_person_id_fk",
    columns: [table.personId],
    foreignColumns: [people.id]
  }),
  unique("founder_research_run_people_item_person_unique")
    .on(table.runItemId, table.personId),
  index("founder_research_run_people_run_item_owner_idx")
    .on(table.runItemId, table.ownerSubject),
  index("founder_research_run_people_person_id_idx").on(table.personId),
  index("founder_research_run_people_owner_subject_idx").on(table.ownerSubject),
  check(
    "founder_research_run_people_identity_status_check",
    sql`${table.identityStatus} in ('VERIFIED','CANDIDATE','CONFIRMED')`
  ),
  check(
    "founder_research_run_people_role_match_check",
    sql`char_length(${table.founderRoleMatch}) between 1 and 128`
  ),
  check(
    "founder_research_run_people_confidence_check",
    sql`${table.confidence} between 0 and 1`
  ),
  check(
    "founder_research_run_people_timestamps_check",
    sql`${table.updatedAt} >= ${table.createdAt}`
  )
]);

export const founderProfileCandidates = careerMcp.table("founder_profile_candidates", {
  id: uuid("id").primaryKey(),
  runPersonId: uuid("run_person_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  profileUrl: text("profile_url").notNull(),
  status: text("status").notNull(),
  sourceKind: text("source_kind").notNull(),
  searchQuery: text("search_query"),
  evidenceUrl: text("evidence_url").notNull(),
  evidenceTitle: text("evidence_title"),
  evidenceSnippet: text("evidence_snippet"),
  evidenceMetadataJson: jsonb("evidence_metadata_json")
    .$type<Record<string, unknown>>()
    .notNull(),
  checkedAt: timestamptz("checked_at").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  unique("founder_profile_candidates_id_owner_unique").on(table.id, table.ownerSubject),
  foreignKey({
    name: "founder_profile_candidates_run_person_owner_fk",
    columns: [table.runPersonId, table.ownerSubject],
    foreignColumns: [founderResearchRunPeople.id, founderResearchRunPeople.ownerSubject]
  }),
  unique("founder_profile_candidates_owner_person_url_unique")
    .on(table.ownerSubject, table.runPersonId, table.profileUrl),
  index("founder_profile_candidates_run_person_owner_idx")
    .on(table.runPersonId, table.ownerSubject),
  index("founder_profile_candidates_owner_subject_idx").on(table.ownerSubject),
  check(
    "founder_profile_candidates_status_check",
    sql`${table.status} in ('VERIFIED','CANDIDATE','CONFIRMED','REJECTED')`
  ),
  check(
    "founder_profile_candidates_source_kind_check",
    sql`
      ${table.sourceKind} in (
        'OFFICIAL_YC',
        'OFFICIAL_COMPANY',
        'PUBLIC_SEARCH',
        'MANUAL_CONFIRMATION'
      )
      and (
        (
          ${table.sourceKind} = 'PUBLIC_SEARCH'
          and ${table.searchQuery} is not null
          and char_length(${table.searchQuery}) between 1 and 500
        )
        or (${table.sourceKind} <> 'PUBLIC_SEARCH' and ${table.searchQuery} is null)
      )
    `
  ),
  check(
    "founder_profile_candidates_profile_url_check",
    sql`
      char_length(${table.profileUrl}) <= 2048
      and octet_length(${table.profileUrl}) <= 4096
      and ${table.profileUrl} ~ '^https://([A-Za-z0-9-]+\\.)*linkedin\\.com/in/[A-Za-z0-9%._~-]+/?$'
    `
  ),
  check(
    "founder_profile_candidates_evidence_bounds_check",
    sql`
      char_length(${table.evidenceUrl}) between 1 and 2048
      and octet_length(${table.evidenceUrl}) <= 4096
      and (${table.evidenceTitle} is null or char_length(${table.evidenceTitle}) between 1 and 512)
      and (
        ${table.evidenceSnippet} is null
        or char_length(${table.evidenceSnippet}) between 1 and 2000
      )
    `
  ),
  check(
    "founder_profile_candidates_confidence_check",
    sql`${table.confidence} between 0 and 1`
  ),
  check(
    "founder_profile_candidates_timestamps_check",
    sql`${table.updatedAt} >= ${table.createdAt}`
  )
]);

export const founderProfileConfirmationEvents = careerMcp.table(
  "founder_profile_confirmation_events",
  {
    id: uuid("id").primaryKey(),
    candidateId: uuid("candidate_id").notNull(),
    ownerSubject: uuid("owner_subject").notNull(),
    event: text("event").notNull(),
    note: text("note"),
    createdAt: timestamptz("created_at").notNull()
  },
  (table) => [
    foreignKey({
      name: "founder_profile_confirmation_events_candidate_owner_fk",
      columns: [table.candidateId, table.ownerSubject],
      foreignColumns: [
        founderProfileCandidates.id,
        founderProfileCandidates.ownerSubject
      ]
    }),
    index("founder_profile_confirmation_events_candidate_owner_idx")
      .on(table.candidateId, table.ownerSubject),
    index("founder_profile_confirmation_events_owner_subject_idx")
      .on(table.ownerSubject),
    check(
      "founder_profile_confirmation_events_event_check",
      sql`${table.event} in ('CONFIRMED','REJECTED')`
    ),
    check(
      "founder_profile_confirmation_events_note_check",
      sql`${table.note} is null or char_length(${table.note}) between 1 and 1000`
    )
  ]
);

export const founderResearchExports = careerMcp.table("founder_research_exports", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  ownerSubject: uuid("owner_subject").notNull(),
  state: text("state").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  workbookBytes: privateBytea("workbook_bytes").notNull(),
  rowCount: integer("row_count").notNull(),
  sheetCount: integer("sheet_count").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull()
}, (table) => [
  unique("founder_research_exports_id_owner_unique").on(table.id, table.ownerSubject),
  foreignKey({
    name: "founder_research_exports_run_owner_fk",
    columns: [table.runId, table.ownerSubject],
    foreignColumns: [founderResearchRuns.id, founderResearchRuns.ownerSubject]
  }),
  index("founder_research_exports_run_owner_idx")
    .on(table.runId, table.ownerSubject),
  index("founder_research_exports_owner_subject_idx").on(table.ownerSubject),
  check(
    "founder_research_exports_state_check",
    sql`${table.state} in ('READY','EXPIRED','DELETED')`
  ),
  check(
    "founder_research_exports_file_name_check",
    sql`
      char_length(${table.fileName}) between 6 and 255
      and ${table.fileName} ~ '\\.xlsx$'
    `
  ),
  check(
    "founder_research_exports_mime_type_check",
    sql`${table.mimeType} = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`
  ),
  check(
    "founder_research_exports_size_check",
    sql`
      ${table.byteSize} between 1 and 5242880
      and octet_length(${table.workbookBytes}) = ${table.byteSize}
    `
  ),
  check(
    "founder_research_exports_checksum_check",
    sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`
  ),
  check(
    "founder_research_exports_counts_check",
    sql`${table.rowCount} >= 0 and ${table.sheetCount} between 1 and 4`
  ),
  check(
    "founder_research_exports_timestamps_check",
    sql`
      ${table.expiresAt} > ${table.createdAt}
      and ${table.expiresAt} <= ${table.createdAt} + interval '7 days'
    `
  )
]);

export const founderExportDownloadCapabilities = careerMcp.table(
  "founder_export_download_capabilities",
  {
    id: uuid("id").primaryKey(),
    exportId: uuid("export_id").notNull(),
    ownerSubject: uuid("owner_subject").notNull(),
    tokenHashSha256: text("token_hash_sha256").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    lastDownloadedAt: timestamptz("last_downloaded_at")
  },
  (table) => [
    foreignKey({
      name: "founder_export_download_capabilities_export_owner_fk",
      columns: [table.exportId, table.ownerSubject],
      foreignColumns: [founderResearchExports.id, founderResearchExports.ownerSubject]
    }),
    uniqueIndex("founder_export_download_capabilities_token_hash_unique")
      .on(table.tokenHashSha256),
    index("founder_export_download_capabilities_export_owner_idx")
      .on(table.exportId, table.ownerSubject),
    index("founder_export_download_capabilities_owner_subject_idx")
      .on(table.ownerSubject),
    check(
      "founder_export_download_capabilities_token_hash_check",
      sql`${table.tokenHashSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "founder_export_download_capabilities_timestamps_check",
      sql`
        ${table.expiresAt} > ${table.createdAt}
        and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'
        and (
          ${table.lastDownloadedAt} is null
          or (
            ${table.lastDownloadedAt} >= ${table.createdAt}
            and ${table.lastDownloadedAt} <= ${table.expiresAt}
          )
        )
      `
    )
  ]
);

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
  founderResearchRuns,
  founderResearchRunItems,
  founderResearchRunPeople,
  founderProfileCandidates,
  founderProfileConfirmationEvents,
  founderResearchExports,
  founderExportDownloadCapabilities,
  oauthTokens
};
