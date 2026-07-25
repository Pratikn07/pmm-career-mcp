ALTER TABLE "career_mcp"."founder_research_exports" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
UPDATE "career_mcp"."founder_research_exports"
SET "idempotency_key_hash" = md5("id"::text) || md5('founder-research-export-legacy-key:' || "id"::text);--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_exports" ALTER COLUMN "idempotency_key_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_exports" ADD CONSTRAINT "founder_research_exports_owner_run_key_snapshot_unique" UNIQUE("owner_subject","run_id","idempotency_key_hash","checksum_sha256");--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_exports" ADD CONSTRAINT "founder_research_exports_idempotency_key_hash_check" CHECK ("career_mcp"."founder_research_exports"."idempotency_key_hash" ~ '^[0-9a-f]{64}$');
