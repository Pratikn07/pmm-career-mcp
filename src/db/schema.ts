import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  ycId: text("yc_id").notNull().unique(),
  name: text("name").notNull(),
  batch: text("batch"),
  status: text("status"),
  websiteUrl: text("website_url"),
  ycUrl: text("yc_url"),
  location: text("location"),
  industry: text("industry"),
  isHiring: integer("is_hiring", { mode: "boolean" }),
  checkedAt: text("checked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  publicProfileUrl: text("public_profile_url"),
  checkedAt: text("checked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("people_company_name_role_unique").on(table.companyId, table.name, table.role)
]);

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id),
  sourceUrl: text("source_url").notNull(),
  title: text("title"),
  factType: text("fact_type"),
  fact: text("fact").notNull(),
  checkedAt: text("checked_at").notNull(),
  confidence: real("confidence").notNull(),
  createdAt: text("created_at").notNull()
});

export const targets = sqliteTable("targets", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull().references(() => people.id).unique(),
  pmmOpportunity: real("pmm_opportunity").notNull(),
  referralPotential: real("referral_potential").notNull(),
  networkValue: real("network_value").notNull(),
  totalScore: real("total_score").notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").notNull(),
  rationale: text("rationale").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const targetNotes = sqliteTable("target_notes", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull().references(() => targets.id),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull()
});

export const outreachDrafts = sqliteTable("outreach_drafts", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull().references(() => targets.id),
  purpose: text("purpose").notNull(),
  text: text("text").notNull(),
  version: integer("version").notNull(),
  evidenceIdsJson: text("evidence_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("outreach_target_purpose_version_unique").on(
    table.targetId,
    table.purpose,
    table.version
  )
]);

export const shortlists = sqliteTable("shortlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const shortlistEntries = sqliteTable("shortlist_entries", {
  id: text("id").primaryKey(),
  shortlistId: text("shortlist_id").notNull().references(() => shortlists.id),
  targetId: text("target_id").notNull().references(() => targets.id),
  position: integer("position").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("shortlist_target_unique").on(table.shortlistId, table.targetId),
  uniqueIndex("shortlist_position_unique").on(table.shortlistId, table.position)
]);

export const postDrafts = sqliteTable("post_drafts", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull(),
  text: text("text").notNull(),
  visibility: text("visibility").notNull(),
  version: integer("version").notNull(),
  checksum: text("checksum").notNull(),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("post_draft_version_unique").on(table.draftId, table.version)
]);

export const postPreviews = sqliteTable("post_previews", {
  id: text("id").primaryKey(),
  postDraftId: text("post_draft_id").notNull().references(() => postDrafts.id),
  version: integer("version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at")
});

export const publishAttempts = sqliteTable("publish_attempts", {
  id: text("id").primaryKey(),
  postDraftId: text("post_draft_id").notNull().references(() => postDrafts.id),
  version: integer("version").notNull(),
  requestedAt: text("requested_at").notNull(),
  responseCategory: text("response_category").notNull(),
  postUrn: text("post_urn"),
  sanitizedError: text("sanitized_error"),
  completedAt: text("completed_at")
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  refreshMetadataCiphertext: text("refresh_metadata_ciphertext"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
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
  postDrafts,
  postPreviews,
  publishAttempts,
  oauthTokens
};
