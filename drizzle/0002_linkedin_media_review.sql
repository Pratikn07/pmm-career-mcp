CREATE TABLE "career_mcp"."post_draft_media" (
	"post_draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"position" integer NOT NULL,
	"media_id" uuid NOT NULL,
	"alt_text" text NOT NULL,
	CONSTRAINT "post_draft_media_pkey" PRIMARY KEY("post_draft_id","version","position"),
	CONSTRAINT "post_draft_media_version_media_unique" UNIQUE("post_draft_id","version","media_id"),
	CONSTRAINT "post_draft_media_position_check" CHECK ("career_mcp"."post_draft_media"."position" between 0 and 3),
	CONSTRAINT "post_draft_media_alt_text_check" CHECK (char_length("career_mcp"."post_draft_media"."alt_text") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."post_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"object_path" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"frame_count" integer DEFAULT 1 NOT NULL,
	"original_filename" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_media_sha256_check" CHECK ("career_mcp"."post_media"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "post_media_mime_check" CHECK ("career_mcp"."post_media"."mime_type" in ('image/jpeg','image/png','image/gif')),
	CONSTRAINT "post_media_size_check" CHECK ("career_mcp"."post_media"."byte_size" between 1 and 20971520),
	CONSTRAINT "post_media_dimensions_check" CHECK ("career_mcp"."post_media"."width" > 0 and "career_mcp"."post_media"."height" > 0 and ("career_mcp"."post_media"."width"::bigint * "career_mcp"."post_media"."height"::bigint) < 36152320),
	CONSTRAINT "post_media_frames_check" CHECK ("career_mcp"."post_media"."frame_count" between 1 and 250)
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."publish_attempt_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publish_attempt_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"linkedin_image_urn" text,
	CONSTRAINT "publish_attempt_media_position_unique" UNIQUE("publish_attempt_id","position"),
	CONSTRAINT "publish_attempt_media_state_check" CHECK ("career_mcp"."publish_attempt_media"."state" in ('pending','initialized','uploaded','definite_failure','unknown'))
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" DROP CONSTRAINT "post_drafts_state_check";--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" DROP CONSTRAINT "publish_attempts_response_category_check";--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD COLUMN "phase" text DEFAULT 'preflight' NOT NULL;--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD COLUMN "media_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "career_mcp"."post_draft_media" ADD CONSTRAINT "post_draft_media_exact_version_fk" FOREIGN KEY ("post_draft_id","version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."post_draft_media" ADD CONSTRAINT "post_draft_media_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "career_mcp"."post_media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempt_media" ADD CONSTRAINT "publish_attempt_media_publish_attempt_id_fk" FOREIGN KEY ("publish_attempt_id") REFERENCES "career_mcp"."publish_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempt_media" ADD CONSTRAINT "publish_attempt_media_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "career_mcp"."post_media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_draft_media_media_id_idx" ON "career_mcp"."post_draft_media" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_media_owner_sha_unique" ON "career_mcp"."post_media" USING btree ("owner_subject","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "post_media_object_path_unique" ON "career_mcp"."post_media" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "publish_attempt_media_publish_attempt_id_idx" ON "career_mcp"."publish_attempt_media" USING btree ("publish_attempt_id");--> statement-breakpoint
CREATE INDEX "publish_attempt_media_media_id_idx" ON "career_mcp"."publish_attempt_media" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD CONSTRAINT "post_drafts_state_check" CHECK ("career_mcp"."post_drafts"."state" in (
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
    ));--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_phase_check" CHECK ("career_mcp"."publish_attempts"."phase" in ('preflight','uploading_media','creating_post','complete'));--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_media_count_check" CHECK ("career_mcp"."publish_attempts"."media_count" between 0 and 4);--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_response_category_check" CHECK ("career_mcp"."publish_attempts"."response_category" in (
      'pending',
      'published',
      'definite_rejection',
      'ambiguous',
      'media_definite_rejection',
      'media_ambiguous'
    ));