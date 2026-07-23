CREATE TABLE "career_mcp"."brand_brief_source_claims" (
	"brief_id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"post_draft_id" uuid NOT NULL,
	"post_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."post_draft_owners" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_draft_owners_draft_owner_unique" UNIQUE("draft_id","owner_subject")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."runtime_role_owners" (
	"role_name" text PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_role_owners_owner_subject_unique" UNIQUE("owner_subject")
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD COLUMN "owner_subject" uuid;
--> statement-breakpoint
LOCK TABLE
	"career_mcp"."post_drafts",
	"career_mcp"."post_draft_media",
	"career_mcp"."post_media",
	"career_mcp"."brand_visual_briefs"
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $legacy_post_ownership$
DECLARE
	configured_owner_text text;
	configured_owner uuid;
BEGIN
	configured_owner_text := NULLIF(
		pg_catalog.current_setting(
			'career_mcp.legacy_post_owner_subject',
			true
		),
		''
	);

	IF configured_owner_text IS NOT NULL THEN
		IF configured_owner_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'legacy_post_owner_required',
				MESSAGE = 'Configured legacy post owner must be a UUID';
		END IF;
		configured_owner := configured_owner_text::uuid;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				post."draft_id",
				pg_catalog.count(DISTINCT media."owner_subject") AS owner_count
			FROM "career_mcp"."post_drafts" AS post
			JOIN "career_mcp"."post_draft_media" AS attachment
				ON attachment."post_draft_id" = post."id"
				AND attachment."version" = post."version"
			JOIN "career_mcp"."post_media" AS media
				ON media."id" = attachment."media_id"
			GROUP BY post."draft_id"
		) AS evidence
		WHERE evidence.owner_count > 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'legacy_post_owner_mismatch',
			MESSAGE = 'Legacy draft media has conflicting owners';
	END IF;

	IF configured_owner IS NOT NULL AND EXISTS (
		SELECT 1
		FROM "career_mcp"."post_drafts" AS post
		JOIN "career_mcp"."post_draft_media" AS attachment
			ON attachment."post_draft_id" = post."id"
			AND attachment."version" = post."version"
		JOIN "career_mcp"."post_media" AS media
			ON media."id" = attachment."media_id"
		WHERE media."owner_subject" IS DISTINCT FROM configured_owner
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'legacy_post_owner_mismatch',
			MESSAGE = 'Configured legacy owner conflicts with media ownership';
	END IF;

	IF configured_owner IS NULL AND EXISTS (
		SELECT 1
		FROM "career_mcp"."post_drafts" AS post
		WHERE NOT EXISTS (
			SELECT 1
			FROM "career_mcp"."post_draft_media" AS attachment
			WHERE attachment."post_draft_id" = post."id"
				AND attachment."version" = post."version"
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'legacy_post_owner_required',
			MESSAGE = 'Legacy text-only drafts require an explicitly configured owner';
	END IF;

	WITH media_owners AS (
		SELECT
			post."draft_id",
			pg_catalog.min(media."owner_subject"::text)::uuid AS owner_subject
		FROM "career_mcp"."post_drafts" AS post
		JOIN "career_mcp"."post_draft_media" AS attachment
			ON attachment."post_draft_id" = post."id"
			AND attachment."version" = post."version"
		JOIN "career_mcp"."post_media" AS media
			ON media."id" = attachment."media_id"
		GROUP BY post."draft_id"
	)
	UPDATE "career_mcp"."post_drafts" AS post
	SET "owner_subject" = COALESCE(
		media_owners.owner_subject,
		configured_owner
	)
	FROM (
		SELECT DISTINCT "draft_id"
		FROM "career_mcp"."post_drafts"
	) AS logical_post
	LEFT JOIN media_owners
		ON media_owners.draft_id = logical_post."draft_id"
	WHERE post."draft_id" = logical_post."draft_id";

	IF EXISTS (
		SELECT 1
		FROM "career_mcp"."post_drafts"
		WHERE "owner_subject" IS NULL
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'legacy_post_owner_required',
			MESSAGE = 'Legacy draft ownership could not be proven';
	END IF;

	INSERT INTO "career_mcp"."post_draft_owners" (
		"draft_id",
		"owner_subject",
		"created_at"
	)
	SELECT
		post."draft_id",
		pg_catalog.min(post."owner_subject"::text)::uuid,
		pg_catalog.now()
	FROM "career_mcp"."post_drafts" AS post
	GROUP BY post."draft_id";

	IF configured_owner IS NOT NULL THEN
		INSERT INTO "career_mcp"."runtime_role_owners" (
			"role_name",
			"owner_subject",
			"created_at"
		) VALUES (
			'career_mcp_runtime',
			configured_owner,
			pg_catalog.now()
		);
	END IF;
END;
$legacy_post_ownership$;
--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts"
	ALTER COLUMN "owner_subject" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_brief_source_claims" ADD CONSTRAINT "brand_brief_source_claims_brief_id_brand_visual_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "career_mcp"."brand_visual_briefs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "career_mcp"."brand_brief_source_claims" ADD CONSTRAINT "brand_brief_source_claims_post_version_fk" FOREIGN KEY ("post_draft_id","post_version") REFERENCES "career_mcp"."post_drafts"("id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "brand_brief_source_claims_owner_subject_idx" ON "career_mcp"."brand_brief_source_claims" USING btree ("owner_subject");
--> statement-breakpoint
CREATE INDEX "brand_brief_source_claims_post_version_idx" ON "career_mcp"."brand_brief_source_claims" USING btree ("post_draft_id","post_version");
--> statement-breakpoint
CREATE INDEX "post_draft_owners_owner_subject_idx" ON "career_mcp"."post_draft_owners" USING btree ("owner_subject");
--> statement-breakpoint
ALTER TABLE "career_mcp"."post_drafts" ADD CONSTRAINT "post_drafts_owner_fk" FOREIGN KEY ("draft_id","owner_subject") REFERENCES "career_mcp"."post_draft_owners"("draft_id","owner_subject") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "post_drafts_owner_idx" ON "career_mcp"."post_drafts" USING btree ("draft_id","owner_subject");
--> statement-breakpoint
DO $legacy_brand_brief_source_claims$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "career_mcp"."brand_visual_briefs" AS brief
		JOIN "career_mcp"."post_drafts" AS post
			ON post."id" = brief."post_draft_id"
			AND post."version" = brief."post_version"
		WHERE brief."owner_subject" IS DISTINCT FROM post."owner_subject"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'brand_brief_source_owner_mismatch',
			MESSAGE = 'Legacy brand brief owner conflicts with post ownership';
	END IF;

	INSERT INTO "career_mcp"."brand_brief_source_claims" (
		"brief_id",
		"owner_subject",
		"post_draft_id",
		"post_version",
		"created_at"
	)
	SELECT
		brief."id",
		post."owner_subject",
		brief."post_draft_id",
		brief."post_version",
		pg_catalog.now()
	FROM "career_mcp"."brand_visual_briefs" AS brief
	JOIN "career_mcp"."post_drafts" AS post
		ON post."id" = brief."post_draft_id"
		AND post."version" = brief."post_version";

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
$legacy_brand_brief_source_claims$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."claim_post_draft_owner"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	configured_owner uuid;
	existing_owner uuid;
BEGIN
	IF SESSION_USER = 'career_mcp_runtime' THEN
		SELECT mapping."owner_subject"
		INTO configured_owner
		FROM "career_mcp"."runtime_role_owners" AS mapping
		WHERE mapping."role_name" = SESSION_USER;

		IF configured_owner IS NULL
			OR NEW."owner_subject" IS DISTINCT FROM configured_owner THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				CONSTRAINT = 'post_draft_owner_unauthorized',
				MESSAGE = 'Post draft owner is not authorized for the runtime role';
		END IF;
	END IF;

	INSERT INTO "career_mcp"."post_draft_owners" (
		"draft_id",
		"owner_subject",
		"created_at"
	) VALUES (
		NEW."draft_id",
		NEW."owner_subject",
		pg_catalog.now()
	)
	ON CONFLICT ("draft_id") DO NOTHING;

	SELECT owner."owner_subject"
	INTO existing_owner
	FROM "career_mcp"."post_draft_owners" AS owner
	WHERE owner."draft_id" = NEW."draft_id";

	IF existing_owner IS DISTINCT FROM NEW."owner_subject" THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'post_draft_owner_immutable',
			MESSAGE = 'Logical post draft ownership is immutable';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."keep_post_draft_owner_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	IF NEW."draft_id" IS DISTINCT FROM OLD."draft_id"
		OR NEW."owner_subject" IS DISTINCT FROM OLD."owner_subject" THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'post_draft_owner_immutable',
			MESSAGE = 'Post draft ownership is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."reject_post_draft_owner_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		CONSTRAINT = 'post_draft_owner_immutable',
		MESSAGE = 'Post draft ownership claims are immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."reject_runtime_role_owner_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		CONSTRAINT = 'runtime_role_owner_immutable',
		MESSAGE = 'Runtime role ownership is operator-managed';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."claim_brand_brief_source"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	actual_owner uuid;
BEGIN
	SELECT post."owner_subject"
	INTO actual_owner
	FROM "career_mcp"."post_drafts" AS post
	JOIN "career_mcp"."post_draft_owners" AS owner
		ON owner."draft_id" = post."draft_id"
		AND owner."owner_subject" = post."owner_subject"
	WHERE post."id" = NEW."post_draft_id"
		AND post."version" = NEW."post_version";

	IF actual_owner IS NULL
		OR NEW."owner_subject" IS DISTINCT FROM actual_owner THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'brand_brief_source_owner_mismatch',
			MESSAGE = 'Brand brief owner must match authoritative post ownership';
	END IF;

	INSERT INTO "career_mcp"."brand_brief_source_claims" (
		"brief_id",
		"owner_subject",
		"post_draft_id",
		"post_version",
		"created_at"
	) VALUES (
		NEW."id",
		actual_owner,
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
	IF NEW."owner_subject" IS DISTINCT FROM OLD."owner_subject"
		OR NEW."post_draft_id" IS DISTINCT FROM OLD."post_draft_id"
		OR NEW."post_version" IS DISTINCT FROM OLD."post_version" THEN
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
REVOKE ALL ON FUNCTION "career_mcp"."claim_post_draft_owner"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."keep_post_draft_owner_immutable"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."reject_post_draft_owner_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."reject_runtime_role_owner_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."claim_brand_brief_source"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."keep_brand_brief_source_immutable"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."reject_brand_brief_source_claim_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."runtime_role_owners" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."post_draft_owners" FROM PUBLIC;
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
		EXECUTE 'revoke insert, update, delete, truncate on table "career_mcp"."runtime_role_owners" from career_mcp_runtime';
		EXECUTE 'grant select on table "career_mcp"."runtime_role_owners" to career_mcp_runtime';
		EXECUTE 'revoke insert, update, delete, truncate on table "career_mcp"."post_draft_owners" from career_mcp_runtime';
		EXECUTE 'grant select on table "career_mcp"."post_draft_owners" to career_mcp_runtime';
		EXECUTE 'revoke insert, update, delete, truncate on table "career_mcp"."brand_brief_source_claims" from career_mcp_runtime';
		EXECUTE 'grant select on table "career_mcp"."brand_brief_source_claims" to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."claim_post_draft_owner"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."keep_post_draft_owner_immutable"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."reject_post_draft_owner_mutation"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."reject_runtime_role_owner_mutation"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."claim_brand_brief_source"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."keep_brand_brief_source_immutable"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."reject_brand_brief_source_claim_mutation"() to career_mcp_runtime';
	END IF;
END;
$runtime_privileges$;
--> statement-breakpoint
CREATE TRIGGER "claim_post_draft_owner_before_insert"
BEFORE INSERT
ON "career_mcp"."post_drafts"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."claim_post_draft_owner"();
--> statement-breakpoint
CREATE TRIGGER "keep_post_draft_owner_immutable_before_update"
BEFORE UPDATE OF "draft_id", "owner_subject"
ON "career_mcp"."post_drafts"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."keep_post_draft_owner_immutable"();
--> statement-breakpoint
CREATE TRIGGER "reject_post_draft_owner_mutation"
BEFORE UPDATE OR DELETE
ON "career_mcp"."post_draft_owners"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."reject_post_draft_owner_mutation"();
--> statement-breakpoint
CREATE TRIGGER "reject_runtime_role_owner_mutation"
BEFORE UPDATE OR DELETE
ON "career_mcp"."runtime_role_owners"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."reject_runtime_role_owner_mutation"();
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
