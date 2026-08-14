CREATE TABLE "career_mcp"."brand_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"public_name" text NOT NULL,
	"role_line" text NOT NULL,
	"series_name" text NOT NULL,
	"monogram" text NOT NULL,
	"voice_json" jsonb NOT NULL,
	"palette_json" jsonb NOT NULL,
	"hook_rules_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_profiles_row_version_unique" UNIQUE("id","version"),
	CONSTRAINT "brand_profiles_owner_version_unique" UNIQUE("owner_subject","version"),
	CONSTRAINT "brand_profiles_version_check" CHECK ("career_mcp"."brand_profiles"."version" >= 1),
	CONSTRAINT "brand_profiles_state_check" CHECK ("career_mcp"."brand_profiles"."state" in ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."brand_visual_briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"post_draft_id" uuid NOT NULL,
	"post_version" integer NOT NULL,
	"brand_profile_id" uuid NOT NULL,
	"brand_profile_version" integer NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"prompt_format_version" integer NOT NULL,
	"visual_mode" text NOT NULL,
	"cover_hook" text NOT NULL,
	"concept_summary" text NOT NULL,
	"topic_label" text,
	"generation_prompt" text NOT NULL,
	"negative_constraints_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_visual_briefs_mode_check" CHECK ("career_mcp"."brand_visual_briefs"."visual_mode" in ('EDITORIAL_STATEMENT','EDITORIAL_METAPHOR')),
	CONSTRAINT "brand_visual_briefs_state_check" CHECK ("career_mcp"."brand_visual_briefs"."state" in ('ready','rendered'))
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."brand_visual_renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_media_id" uuid,
	"rendered_media_id" uuid NOT NULL,
	"alt_text" text NOT NULL,
	"render_checksum" text NOT NULL,
	"renderer_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_visual_renders_brief_version_unique" UNIQUE("brief_id","version"),
	CONSTRAINT "brand_visual_renders_version_check" CHECK ("career_mcp"."brand_visual_renders"."version" >= 1),
	CONSTRAINT "brand_visual_renders_renderer_version_check" CHECK ("career_mcp"."brand_visual_renders"."renderer_version" >= 1),
	CONSTRAINT "brand_visual_renders_checksum_check" CHECK ("career_mcp"."brand_visual_renders"."render_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "brand_visual_renders_alt_text_check" CHECK (char_length("career_mcp"."brand_visual_renders"."alt_text") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_briefs" ADD CONSTRAINT "brand_visual_briefs_post_version_fk" FOREIGN KEY ("post_draft_id","post_version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_briefs" ADD CONSTRAINT "brand_visual_briefs_profile_version_fk" FOREIGN KEY ("brand_profile_id","brand_profile_version") REFERENCES "career_mcp"."brand_profiles"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_renders" ADD CONSTRAINT "brand_visual_renders_brief_id_brand_visual_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "career_mcp"."brand_visual_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_renders" ADD CONSTRAINT "brand_visual_renders_source_media_id_post_media_id_fk" FOREIGN KEY ("source_media_id") REFERENCES "career_mcp"."post_media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_renders" ADD CONSTRAINT "brand_visual_renders_rendered_media_id_post_media_id_fk" FOREIGN KEY ("rendered_media_id") REFERENCES "career_mcp"."post_media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_profiles_one_active_owner_unique" ON "career_mcp"."brand_profiles" USING btree ("owner_subject") WHERE "career_mcp"."brand_profiles"."state" = 'active';--> statement-breakpoint
CREATE INDEX "brand_visual_briefs_post_version_idx" ON "career_mcp"."brand_visual_briefs" USING btree ("post_draft_id","post_version");--> statement-breakpoint
CREATE INDEX "brand_visual_briefs_profile_version_idx" ON "career_mcp"."brand_visual_briefs" USING btree ("brand_profile_id","brand_profile_version");--> statement-breakpoint
CREATE INDEX "brand_visual_briefs_owner_created_idx" ON "career_mcp"."brand_visual_briefs" USING btree ("owner_subject","created_at");--> statement-breakpoint
CREATE INDEX "brand_visual_renders_brief_id_idx" ON "career_mcp"."brand_visual_renders" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "brand_visual_renders_source_media_id_idx" ON "career_mcp"."brand_visual_renders" USING btree ("source_media_id");--> statement-breakpoint
CREATE INDEX "brand_visual_renders_rendered_media_id_idx" ON "career_mcp"."brand_visual_renders" USING btree ("rendered_media_id");