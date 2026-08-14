CREATE SCHEMA IF NOT EXISTS "career_mcp";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SCHEMA "career_mcp" FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE "career_mcp"."companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"yc_id" text NOT NULL,
	"name" text NOT NULL,
	"batch" text,
	"status" text,
	"website_url" text,
	"yc_url" text,
	"location" text,
	"industry" text,
	"is_hiring" boolean,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "companies_yc_id_unique" UNIQUE("yc_id")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"title" text,
	"fact_type" text,
	"fact" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"refresh_metadata_ciphertext" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_tokens_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."outreach_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"text" text NOT NULL,
	"version" integer NOT NULL,
	"evidence_ids_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"public_profile_url" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."post_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft_id" uuid NOT NULL,
	"text" text NOT NULL,
	"visibility" text NOT NULL,
	"version" integer NOT NULL,
	"checksum" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_draft_version_unique" UNIQUE("draft_id","version"),
	CONSTRAINT "post_draft_row_version_unique" UNIQUE("id","version")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."post_previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "post_previews_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."publish_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"response_category" text NOT NULL,
	"post_urn" text,
	"sanitized_error" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."shortlist_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shortlist_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."shortlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."target_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"pmm_opportunity" double precision NOT NULL,
	"referral_potential" double precision NOT NULL,
	"network_value" double precision NOT NULL,
	"total_score" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"status" text NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "targets_person_id_unique" UNIQUE("person_id")
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."evidence" ADD CONSTRAINT "evidence_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "career_mcp"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."outreach_drafts" ADD CONSTRAINT "outreach_drafts_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "career_mcp"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."people" ADD CONSTRAINT "people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "career_mcp"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."post_previews" ADD CONSTRAINT "post_previews_post_draft_id_post_drafts_id_fk" FOREIGN KEY ("post_draft_id") REFERENCES "career_mcp"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."post_previews" ADD CONSTRAINT "post_previews_exact_version_fk" FOREIGN KEY ("post_draft_id","version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_post_draft_id_post_drafts_id_fk" FOREIGN KEY ("post_draft_id") REFERENCES "career_mcp"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_exact_version_fk" FOREIGN KEY ("post_draft_id","version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "career_mcp"."shortlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "career_mcp"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."target_notes" ADD CONSTRAINT "target_notes_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "career_mcp"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "career_mcp"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_target_purpose_version_unique" ON "career_mcp"."outreach_drafts" USING btree ("target_id","purpose","version");--> statement-breakpoint
CREATE UNIQUE INDEX "people_company_name_role_unique" ON "career_mcp"."people" USING btree ("company_id","name","role");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlist_target_unique" ON "career_mcp"."shortlist_entries" USING btree ("shortlist_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlist_position_unique" ON "career_mcp"."shortlist_entries" USING btree ("shortlist_id","position");--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "career_mcp" FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA career_mcp FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA career_mcp FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA career_mcp FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA career_mcp FROM authenticated';
  END IF;
END
$$;
