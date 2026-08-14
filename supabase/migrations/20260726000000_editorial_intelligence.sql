begin;

alter table career_mcp.brand_visual_briefs
  add column visual_content_json jsonb;

alter table career_mcp.brand_visual_briefs
  drop constraint brand_visual_briefs_mode_check;

alter table career_mcp.brand_visual_briefs
  add constraint brand_visual_briefs_mode_check
  check (
    visual_mode in (
      'EDITORIAL_STATEMENT',
      'EDITORIAL_EVIDENCE',
      'EDITORIAL_MODEL',
      'EDITORIAL_METAPHOR'
    )
  );

commit;
