ALTER TABLE "career_mcp"."post_previews" DROP CONSTRAINT "post_previews_post_draft_id_post_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" DROP CONSTRAINT "publish_attempts_post_draft_id_post_drafts_id_fk";
--> statement-breakpoint
CREATE INDEX "evidence_person_id_idx" ON "career_mcp"."evidence" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "post_previews_post_draft_version_idx" ON "career_mcp"."post_previews" USING btree ("post_draft_id","version");--> statement-breakpoint
CREATE INDEX "publish_attempts_post_draft_version_idx" ON "career_mcp"."publish_attempts" USING btree ("post_draft_id","version");--> statement-breakpoint
CREATE INDEX "shortlist_entries_target_id_idx" ON "career_mcp"."shortlist_entries" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "target_notes_target_id_idx" ON "career_mcp"."target_notes" USING btree ("target_id");--> statement-breakpoint
ALTER TABLE "career_mcp"."evidence" ADD CONSTRAINT "evidence_confidence_range_check" CHECK ("career_mcp"."evidence"."confidence" >= 0 and "career_mcp"."evidence"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "career_mcp"."outreach_drafts" ADD CONSTRAINT "outreach_drafts_version_check" CHECK ("career_mcp"."outreach_drafts"."version" >= 1);--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD CONSTRAINT "post_drafts_version_check" CHECK ("career_mcp"."post_drafts"."version" >= 1);--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD CONSTRAINT "post_drafts_visibility_check" CHECK ("career_mcp"."post_drafts"."visibility" in ('PUBLIC', 'CONNECTIONS'));--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD CONSTRAINT "post_drafts_state_check" CHECK ("career_mcp"."post_drafts"."state" in (
      'draft',
      'ready_for_preview',
      'publishing',
      'published',
      'publish_failed',
      'publish_unknown'
    ));--> statement-breakpoint
ALTER TABLE "career_mcp"."publish_attempts" ADD CONSTRAINT "publish_attempts_response_category_check" CHECK ("career_mcp"."publish_attempts"."response_category" in (
      'pending',
      'published',
      'definite_rejection',
      'ambiguous'
    ));--> statement-breakpoint
ALTER TABLE "career_mcp"."shortlist_entries" ADD CONSTRAINT "shortlist_entries_position_check" CHECK ("career_mcp"."shortlist_entries"."position" >= 0);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_pmm_opportunity_range_check" CHECK ("career_mcp"."targets"."pmm_opportunity" >= 0 and "career_mcp"."targets"."pmm_opportunity" <= 100);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_referral_potential_range_check" CHECK ("career_mcp"."targets"."referral_potential" >= 0 and "career_mcp"."targets"."referral_potential" <= 100);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_network_value_range_check" CHECK ("career_mcp"."targets"."network_value" >= 0 and "career_mcp"."targets"."network_value" <= 100);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_total_score_range_check" CHECK ("career_mcp"."targets"."total_score" >= 0 and "career_mcp"."targets"."total_score" <= 100);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_confidence_range_check" CHECK ("career_mcp"."targets"."confidence" >= 0 and "career_mcp"."targets"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "career_mcp"."targets" ADD CONSTRAINT "targets_status_check" CHECK ("career_mcp"."targets"."status" in (
      'discovered',
      'shortlisted',
      'connect_planned',
      'connected',
      'contacted',
      'replied',
      'archived'
    ));