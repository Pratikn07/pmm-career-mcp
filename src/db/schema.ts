import {
  boolean,
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
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
});

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
});

export const targetNotes = careerMcp.table("target_notes", {
  id: uuid("id").primaryKey(),
  targetId: uuid("target_id").notNull().references(() => targets.id),
  text: text("text").notNull(),
  createdAt: timestamptz("created_at").notNull()
});

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
  uniqueIndex("shortlist_position_unique").on(table.shortlistId, table.position)
]);

export const postDrafts = careerMcp.table("post_drafts", {
  id: uuid("id").primaryKey(),
  draftId: uuid("draft_id").notNull(),
  text: text("text").notNull(),
  visibility: text("visibility").notNull(),
  version: integer("version").notNull(),
  checksum: text("checksum").notNull(),
  state: text("state").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at").notNull()
}, (table) => [
  unique("post_draft_version_unique").on(table.draftId, table.version),
  unique("post_draft_row_version_unique").on(table.id, table.version)
]);

export const postPreviews = careerMcp.table("post_previews", {
  id: uuid("id").primaryKey(),
  postDraftId: uuid("post_draft_id").notNull().references(() => postDrafts.id),
  version: integer("version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamptz("expires_at").notNull(),
  consumedAt: timestamptz("consumed_at")
}, (table) => [
  foreignKey({
    name: "post_previews_exact_version_fk",
    columns: [table.postDraftId, table.version],
    foreignColumns: [postDrafts.id, postDrafts.version]
  })
]);

export const publishAttempts = careerMcp.table("publish_attempts", {
  id: uuid("id").primaryKey(),
  postDraftId: uuid("post_draft_id").notNull().references(() => postDrafts.id),
  version: integer("version").notNull(),
  requestedAt: timestamptz("requested_at").notNull(),
  responseCategory: text("response_category").notNull(),
  postUrn: text("post_urn"),
  sanitizedError: text("sanitized_error"),
  completedAt: timestamptz("completed_at")
}, (table) => [
  foreignKey({
    name: "publish_attempts_exact_version_fk",
    columns: [table.postDraftId, table.version],
    foreignColumns: [postDrafts.id, postDrafts.version]
  })
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
  postDrafts,
  postPreviews,
  publishAttempts,
  oauthTokens
};
