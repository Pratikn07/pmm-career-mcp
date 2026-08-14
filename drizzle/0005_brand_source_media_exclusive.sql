CREATE TABLE "career_mcp"."media_usage_claims" (
	"media_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_usage_claims_pkey" PRIMARY KEY("media_id"),
	CONSTRAINT "media_usage_claims_purpose_check" CHECK ("career_mcp"."media_usage_claims"."purpose" in ('attached','brand_source'))
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."media_usage_claims" ADD CONSTRAINT "media_usage_claims_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "career_mcp"."post_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_usage_claims_owner_subject_idx" ON "career_mcp"."media_usage_claims" USING btree ("owner_subject");
--> statement-breakpoint
LOCK TABLE
  "career_mcp"."post_draft_media",
  "career_mcp"."brand_visual_renders"
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "career_mcp"."media_usage_claims" AS claim (
  "media_id",
  "owner_subject",
  "purpose",
  "created_at"
)
SELECT
  attachment."media_id",
  media."owner_subject",
  'attached',
  pg_catalog.now()
FROM "career_mcp"."post_draft_media" AS attachment
INNER JOIN "career_mcp"."post_media" AS media
  ON media."id" = attachment."media_id"
GROUP BY attachment."media_id", media."owner_subject"
ON CONFLICT ("media_id") DO UPDATE
SET "owner_subject" = EXCLUDED."owner_subject"
WHERE claim."purpose" = EXCLUDED."purpose";
--> statement-breakpoint
INSERT INTO "career_mcp"."media_usage_claims" AS claim (
  "media_id",
  "owner_subject",
  "purpose",
  "created_at"
)
SELECT
  render."source_media_id",
  media."owner_subject",
  'brand_source',
  pg_catalog.now()
FROM "career_mcp"."brand_visual_renders" AS render
INNER JOIN "career_mcp"."post_media" AS media
  ON media."id" = render."source_media_id"
WHERE render."source_media_id" IS NOT NULL
GROUP BY render."source_media_id", media."owner_subject"
ON CONFLICT ("media_id") DO UPDATE
SET "owner_subject" = EXCLUDED."owner_subject"
WHERE claim."purpose" = EXCLUDED."purpose";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "career_mcp"."brand_visual_renders" AS render
    INNER JOIN "career_mcp"."media_usage_claims" AS claim
      ON claim."media_id" = render."source_media_id"
    WHERE render."source_media_id" IS NOT NULL
      AND claim."purpose" <> 'brand_source'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Brand render source media cannot be attached to a post draft';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."claim_post_draft_media_usage"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_purpose text;
BEGIN
  INSERT INTO "career_mcp"."media_usage_claims" AS claim (
    "media_id",
    "owner_subject",
    "purpose",
    "created_at"
  )
  SELECT
    NEW."media_id",
    media."owner_subject",
    'attached',
    pg_catalog.now()
  FROM "career_mcp"."post_media" AS media
  WHERE media."id" = NEW."media_id"
  ON CONFLICT ("media_id") DO UPDATE
  SET "owner_subject" = EXCLUDED."owner_subject"
  WHERE claim."purpose" = EXCLUDED."purpose"
  RETURNING claim."purpose" INTO claimed_purpose;

  IF claimed_purpose IS DISTINCT FROM 'attached' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Brand render source media cannot be attached to a post draft';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."claim_brand_source_media_usage"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed_purpose text;
BEGIN
  IF NEW."source_media_id" IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "career_mcp"."media_usage_claims" AS claim (
    "media_id",
    "owner_subject",
    "purpose",
    "created_at"
  )
  SELECT
    NEW."source_media_id",
    media."owner_subject",
    'brand_source',
    pg_catalog.now()
  FROM "career_mcp"."post_media" AS media
  WHERE media."id" = NEW."source_media_id"
  ON CONFLICT ("media_id") DO UPDATE
  SET "owner_subject" = EXCLUDED."owner_subject"
  WHERE claim."purpose" = EXCLUDED."purpose"
  RETURNING claim."purpose" INTO claimed_purpose;

  IF claimed_purpose IS DISTINCT FROM 'brand_source' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'brand_source_media_exclusive',
      MESSAGE = 'Attached post media cannot be used as a brand render source';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."claim_post_draft_media_usage"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."claim_brand_source_media_usage"() FROM PUBLIC;
--> statement-breakpoint
DO $runtime_privileges$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'career_mcp_runtime'
  ) THEN
    EXECUTE 'revoke insert, update, delete, truncate on table "career_mcp"."media_usage_claims" from career_mcp_runtime';
    EXECUTE 'grant select on table "career_mcp"."media_usage_claims" to career_mcp_runtime';
    EXECUTE 'grant execute on function "career_mcp"."claim_post_draft_media_usage"() to career_mcp_runtime';
    EXECUTE 'grant execute on function "career_mcp"."claim_brand_source_media_usage"() to career_mcp_runtime';
  END IF;
END;
$runtime_privileges$;
--> statement-breakpoint
CREATE TRIGGER "brand_source_media_exclusive_on_post_draft_media"
BEFORE INSERT OR UPDATE OF "media_id"
ON "career_mcp"."post_draft_media"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."claim_post_draft_media_usage"();
--> statement-breakpoint
CREATE TRIGGER "brand_source_media_exclusive_on_render"
BEFORE INSERT OR UPDATE OF "source_media_id"
ON "career_mcp"."brand_visual_renders"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."claim_brand_source_media_usage"();
