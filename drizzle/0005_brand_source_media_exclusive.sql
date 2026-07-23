LOCK TABLE
  "career_mcp"."post_draft_media",
  "career_mcp"."brand_visual_renders"
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "career_mcp"."brand_visual_renders" AS render
    INNER JOIN "career_mcp"."post_draft_media" AS attachment
      ON attachment."media_id" = render."source_media_id"
    WHERE render."source_media_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Brand render source media cannot be attached to a post draft';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."check_post_draft_media_not_brand_source"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW."media_id"::text, 719291484472341011)
  );
  IF EXISTS (
    SELECT 1
    FROM "career_mcp"."brand_visual_renders" AS render
    WHERE render."source_media_id" = NEW."media_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Brand render source media cannot be attached to a post draft';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."check_brand_source_media_not_attached"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW."source_media_id" IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW."source_media_id"::text, 719291484472341011)
  );
  IF EXISTS (
    SELECT 1
    FROM "career_mcp"."post_draft_media" AS attachment
    WHERE attachment."media_id" = NEW."source_media_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Attached post media cannot be used as a brand render source';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "brand_source_media_exclusive_on_post_draft_media"
BEFORE INSERT OR UPDATE OF "media_id"
ON "career_mcp"."post_draft_media"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."check_post_draft_media_not_brand_source"();
--> statement-breakpoint
CREATE TRIGGER "brand_source_media_exclusive_on_render"
BEFORE INSERT OR UPDATE OF "source_media_id"
ON "career_mcp"."brand_visual_renders"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."check_brand_source_media_not_attached"();
