ALTER TABLE "career_mcp"."brand_visual_briefs" DROP CONSTRAINT "brand_visual_briefs_mode_check";--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_briefs" ADD COLUMN "visual_content_json" jsonb;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_visual_briefs" ADD CONSTRAINT "brand_visual_briefs_mode_check" CHECK ("career_mcp"."brand_visual_briefs"."visual_mode" in (
      'EDITORIAL_STATEMENT',
      'EDITORIAL_EVIDENCE',
      'EDITORIAL_MODEL',
      'EDITORIAL_METAPHOR'
    ));