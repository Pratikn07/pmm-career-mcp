CREATE TABLE "career_mcp"."brand_brief_source_claims" (
	"brief_id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"post_draft_id" uuid NOT NULL,
	"post_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_brief_source_claims" ADD CONSTRAINT "brand_brief_source_claims_brief_id_brand_visual_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "career_mcp"."brand_visual_briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_brief_source_claims" ADD CONSTRAINT "brand_brief_source_claims_post_version_fk" FOREIGN KEY ("post_draft_id","post_version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_brief_source_claims_owner_subject_idx" ON "career_mcp"."brand_brief_source_claims" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "brand_brief_source_claims_post_version_idx" ON "career_mcp"."brand_brief_source_claims" USING btree ("post_draft_id","post_version");
--> statement-breakpoint
LOCK TABLE "career_mcp"."brand_visual_briefs" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "career_mcp"."brand_brief_source_claims" (
	"brief_id",
	"owner_subject",
	"post_draft_id",
	"post_version",
	"created_at"
)
SELECT
	brief."id",
	brief."owner_subject",
	brief."post_draft_id",
	brief."post_version",
	pg_catalog.now()
FROM "career_mcp"."brand_visual_briefs" AS brief;
--> statement-breakpoint
DO $brand_brief_source_claim_backfill$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "career_mcp"."brand_visual_briefs" AS brief
		LEFT JOIN "career_mcp"."brand_brief_source_claims" AS claim
			ON claim."brief_id" = brief."id"
		WHERE
			claim."brief_id" IS NULL
			OR claim."owner_subject" IS DISTINCT FROM brief."owner_subject"
			OR claim."post_draft_id" IS DISTINCT FROM brief."post_draft_id"
			OR claim."post_version" IS DISTINCT FROM brief."post_version"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'brand_brief_source_claim_backfill',
			MESSAGE = 'Brand brief source claim backfill is inconsistent';
	END IF;
END;
$brand_brief_source_claim_backfill$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."claim_brand_brief_source"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
	INSERT INTO "career_mcp"."brand_brief_source_claims" (
		"brief_id",
		"owner_subject",
		"post_draft_id",
		"post_version",
		"created_at"
	) VALUES (
		NEW."id",
		NEW."owner_subject",
		NEW."post_draft_id",
		NEW."post_version",
		pg_catalog.now()
	);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."keep_brand_brief_source_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	IF (
		NEW."owner_subject" IS DISTINCT FROM OLD."owner_subject"
		OR NEW."post_draft_id" IS DISTINCT FROM OLD."post_draft_id"
		OR NEW."post_version" IS DISTINCT FROM OLD."post_version"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'brand_brief_source_immutable',
			MESSAGE = 'Brand brief source identity is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."reject_brand_brief_source_claim_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		CONSTRAINT = 'brand_brief_source_claim_immutable',
		MESSAGE = 'Brand brief source claims are immutable';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."claim_brand_brief_source"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."keep_brand_brief_source_immutable"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."reject_brand_brief_source_claim_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."brand_brief_source_claims" FROM PUBLIC;
--> statement-breakpoint
DO $runtime_privileges$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_roles
		WHERE rolname = 'career_mcp_runtime'
	) THEN
		EXECUTE 'revoke insert, update, delete, truncate on table "career_mcp"."brand_brief_source_claims" from career_mcp_runtime';
		EXECUTE 'grant select on table "career_mcp"."brand_brief_source_claims" to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."claim_brand_brief_source"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."keep_brand_brief_source_immutable"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."reject_brand_brief_source_claim_mutation"() to career_mcp_runtime';
	END IF;
END;
$runtime_privileges$;
--> statement-breakpoint
CREATE TRIGGER "claim_brand_brief_source_after_insert"
AFTER INSERT
ON "career_mcp"."brand_visual_briefs"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."claim_brand_brief_source"();
--> statement-breakpoint
CREATE TRIGGER "keep_brand_brief_source_immutable_before_update"
BEFORE UPDATE OF "owner_subject", "post_draft_id", "post_version"
ON "career_mcp"."brand_visual_briefs"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."keep_brand_brief_source_immutable"();
--> statement-breakpoint
CREATE TRIGGER "reject_brand_brief_source_claim_mutation"
BEFORE UPDATE OR DELETE
ON "career_mcp"."brand_brief_source_claims"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."reject_brand_brief_source_claim_mutation"();
