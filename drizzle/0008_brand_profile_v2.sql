WITH "legacy_profiles" AS (
	SELECT legacy.*
	FROM "career_mcp"."brand_profiles" AS legacy
	WHERE legacy."version" = 1
		AND legacy."state" = 'active'
		AND legacy."series_name" = 'PMM FIELD NOTES'
		AND NOT EXISTS (
			SELECT 1
			FROM "career_mcp"."brand_profiles" AS current_profile
			WHERE current_profile."owner_subject" = legacy."owner_subject"
				AND current_profile."version" = 2
		)
),
"retired_profiles" AS (
	UPDATE "career_mcp"."brand_profiles" AS legacy
	SET "state" = 'retired'
	FROM "legacy_profiles" AS candidate
	WHERE legacy."id" = candidate."id"
	RETURNING legacy.*
)
INSERT INTO "career_mcp"."brand_profiles" (
	"id",
	"owner_subject",
	"version",
	"state",
	"public_name",
	"role_line",
	"series_name",
	"monogram",
	"voice_json",
	"palette_json",
	"hook_rules_json",
	"created_at"
)
SELECT
	pg_catalog.gen_random_uuid(),
	retired."owner_subject",
	2,
	'active',
	retired."public_name",
	retired."role_line",
	'EDITORIAL INTELLIGENCE',
	retired."monogram",
	retired."voice_json",
	retired."palette_json",
	retired."hook_rules_json",
	pg_catalog.now()
FROM "retired_profiles" AS retired;
