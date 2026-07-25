ALTER TABLE "career_mcp"."outreach_drafts" ADD COLUMN "request_payload_hash" text;--> statement-breakpoint
ALTER TABLE "career_mcp"."outreach_drafts" ADD CONSTRAINT "outreach_drafts_request_identity_check" CHECK ((
      ("career_mcp"."outreach_drafts"."request_id" is null and "career_mcp"."outreach_drafts"."request_payload_hash" is null)
      or ("career_mcp"."outreach_drafts"."request_id" is not null and "career_mcp"."outreach_drafts"."request_payload_hash" ~ '^[0-9a-f]{64}$')
    ));