import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function runtimeRoleSql(): Promise<string> {
  return await readFile(resolve("supabase/runtime-role.sql"), "utf8");
}

async function initialMigrationSql(): Promise<string> {
  return await readFile(resolve("drizzle/0000_initial.sql"), "utf8");
}

async function mediaMigrationSql(): Promise<string> {
  return await readFile(resolve("drizzle/0002_linkedin_media_review.sql"), "utf8");
}

async function brandSourceExclusivityMigrationSql(): Promise<string> {
  return await readFile(resolve("drizzle/0005_brand_source_media_exclusive.sql"), "utf8");
}

async function brandSourceExclusivitySnapshot(): Promise<string> {
  return await readFile(resolve("drizzle/meta/0005_snapshot.json"), "utf8");
}

async function brandBriefSourceClaimsMigrationSql(): Promise<string> {
  return await readFile(resolve("drizzle/0006_brand_brief_source_claims.sql"), "utf8");
}

async function brandBriefSourceClaimsSnapshot(): Promise<string> {
  return await readFile(resolve("drizzle/meta/0006_snapshot.json"), "utf8");
}

describe("Supabase runtime-role operator template", () => {
  it("allows migrations after the runtime-role template bootstraps the private schema", async () => {
    const sql = await initialMigrationSql();

    expect(sql).toMatch(/create\s+schema\s+if\s+not\s+exists\s+"career_mcp"/i);
  });

  it("idempotently bootstraps the private schema without taking ownership of an existing schema", async () => {
    const sql = await runtimeRoleSql();
    const createSchema = sql.search(/create\s+schema\s+if\s+not\s+exists\s+career_mcp/i);
    const firstGrant = sql.search(/grant\s+usage\s+on\s+schema\s+career_mcp/i);
    const defaultPrivileges = sql.search(/alter\s+default\s+privileges\s+in\s+schema\s+career_mcp/i);

    expect(createSchema).toBeGreaterThan(-1);
    expect(createSchema).toBeLessThan(firstGrant);
    expect(createSchema).toBeLessThan(defaultPrivileges);
    expect(sql).not.toMatch(/alter\s+schema\s+career_mcp\s+owner/i);
    expect(sql).not.toMatch(/drop\s+schema\s+career_mcp/i);
  });

  it("creates an idempotent least-privilege NOINHERIT login and prompts privately for its password", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/where\s+rolname\s*=\s*'career_mcp_runtime'/i);
    expect(sql).toMatch(/create\s+role\s+career_mcp_runtime/i);
    expect(sql).toMatch(/alter\s+role\s+career_mcp_runtime[\s\S]*noinherit[\s\S]*login/i);
    expect(sql).toMatch(/\\password\s+career_mcp_runtime/i);
    expect(sql).not.toMatch(/password\s+['"][^'"]+['"]/i);
  });

  it("works with Supabase's non-superuser postgres owner and fails closed on unsafe reused attributes", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/rolsuper[\s\S]*rolcreatedb[\s\S]*rolcreaterole[\s\S]*rolreplication[\s\S]*rolbypassrls/i);
    expect(sql).toMatch(/raise\s+exception[\s\S]*unsafe role attributes/i);
    expect(sql).not.toMatch(/alter\s+role\s+career_mcp_runtime[\s\S]{0,180}\b(?:nosuperuser|nocreatedb|nocreaterole|noreplication|nobypassrls)\b/i);
  });

  it("keeps the claim ledger read-only after broad current and future application grants", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+career_mcp\s+to\s+career_mcp_runtime/i);
    expect(sql).toMatch(/grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+all\s+tables\s+in\s+schema\s+career_mcp/i);
    expect(sql).toMatch(/grant\s+usage,\s*select\s+on\s+all\s+sequences\s+in\s+schema\s+career_mcp/i);
    expect(sql).toMatch(/alter\s+default\s+privileges\s+in\s+schema\s+career_mcp/i);
    const broadCurrentGrant = sql.search(
      /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+all\s+tables\s+in\s+schema\s+career_mcp/i
    );
    const broadDefaultGrant = sql.search(
      /alter\s+default\s+privileges\s+in\s+schema\s+career_mcp[\s\S]*?grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+tables\s+to\s+career_mcp_runtime/i
    );
    const claimMutationRevoke = sql.search(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+table\s+career_mcp\.media_usage_claims\s+from\s+career_mcp_runtime/i
    );
    expect(claimMutationRevoke).toBeGreaterThan(broadCurrentGrant);
    expect(claimMutationRevoke).toBeGreaterThan(broadDefaultGrant);
    expect(sql).toMatch(
      /grant\s+select\s+on\s+table\s+career_mcp\.media_usage_claims\s+to\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+career_mcp\.claim_post_draft_media_usage\(\)\s+to\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+career_mcp\.claim_brand_source_media_usage\(\)\s+to\s+career_mcp_runtime/i
    );
    const briefClaimMutationRevoke = sql.search(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+table\s+career_mcp\.brand_brief_source_claims\s+from\s+career_mcp_runtime/i
    );
    expect(briefClaimMutationRevoke).toBeGreaterThan(broadCurrentGrant);
    expect(briefClaimMutationRevoke).toBeGreaterThan(broadDefaultGrant);
    expect(sql).toMatch(
      /grant\s+select\s+on\s+table\s+career_mcp\.brand_brief_source_claims\s+to\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+career_mcp\.claim_brand_brief_source\(\)\s+to\s+career_mcp_runtime/i
    );
    expect(sql).not.toMatch(/grant[\s\S]{0,120}\b(?:public|anon|authenticated)\b/i);
    expect(sql).not.toMatch(/grant\s+(?:create|all)(?:\s+privileges)?\s+on\s+schema/i);
  });

  it("keeps normalized media private and does not mutate Supabase Storage from the Drizzle migration", async () => {
    const sql = await mediaMigrationSql();

    expect(sql).toMatch(/create\s+table\s+"career_mcp"\."post_media"/i);
    expect(sql).toMatch(/create\s+table\s+"career_mcp"\."post_draft_media"/i);
    expect(sql).toMatch(/create\s+table\s+"career_mcp"\."publish_attempt_media"/i);
    expect(sql).not.toMatch(/storage\s*\.\s*(?:buckets|objects)/i);
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\b[\s\S]{0,80}\bstorage\b/i);
    expect(sql).not.toMatch(/\bgrant\b[\s\S]{0,100}\b(?:anon|authenticated)\b/i);
    expect(sql).not.toMatch(/enable\s+row\s+level\s+security/i);
  });

  it("uses restricted definer trigger functions for the private immutable claim ledger", async () => {
    const sql = await brandSourceExclusivityMigrationSql();

    expect(sql).toMatch(/career_mcp[\s\S]*post_draft_media/i);
    expect(sql).toMatch(/career_mcp[\s\S]*brand_visual_renders/i);
    expect(sql).toMatch(/create\s+table\s+"career_mcp"\."media_usage_claims"/i);
    expect(sql).toMatch(
      /lock\s+table[\s\S]*post_draft_media[\s\S]*brand_visual_renders[\s\S]*share\s+row\s+exclusive/i
    );
    const attachedBackfill = sql.indexOf("  'attached',\n  pg_catalog.now()");
    const sourceBackfill = sql.indexOf("  'brand_source',\n  pg_catalog.now()");
    expect(attachedBackfill).toBeGreaterThan(-1);
    expect(sourceBackfill).toBeGreaterThan(attachedBackfill);
    expect(sql).toMatch(/on\s+conflict\s*\(\s*"media_id"\s*\)\s+do\s+update/i);
    expect(sql).toMatch(/constraint\s*=\s*'brand_source_media_exclusive'/i);
    expect(sql).not.toMatch(/pg_advisory_xact_lock/i);
    expect(sql.match(/security\s+definer/gi)).toHaveLength(2);
    expect(sql.match(/set\s+search_path\s*=\s*''/gi)).toHaveLength(2);
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+"career_mcp"\."claim_post_draft_media_usage"\(\)\s+from\s+public/i
    );
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+"career_mcp"\."claim_brand_source_media_usage"\(\)\s+from\s+public/i
    );
    expect(sql).toMatch(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+table\s+"career_mcp"\."media_usage_claims"\s+from\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+"career_mcp"\."claim_post_draft_media_usage"\(\)\s+to\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+"career_mcp"\."claim_brand_source_media_usage"\(\)\s+to\s+career_mcp_runtime/i
    );
    expect(sql).not.toMatch(
      /alter\s+function[\s\S]{0,160}owner\s+to\s+career_mcp_runtime/i
    );
    expect(sql).not.toMatch(/storage\s*\.\s*(?:buckets|objects)/i);
    expect(sql).not.toMatch(/\bgrant\b[\s\S]{0,100}\b(?:public|anon|authenticated)\b/i);
    expect(sql).not.toMatch(/\bservice_role\b/i);
  });

  it("records the persistent claim table in Drizzle migration metadata", async () => {
    const snapshot = await brandSourceExclusivitySnapshot();

    expect(snapshot).toMatch(/career_mcp\.media_usage_claims/i);
    expect(snapshot).toMatch(/media_usage_claims_media_id_fk/i);
    expect(snapshot).toMatch(/media_usage_claims_purpose_check/i);
  });

  it("backfills and enforces immutable owner-scoped brand brief source claims", async () => {
    const sql = await brandBriefSourceClaimsMigrationSql();

    expect(sql).toMatch(/create\s+table\s+"career_mcp"\."brand_brief_source_claims"/i);
    expect(sql).toMatch(
      /lock\s+table\s+"career_mcp"\."brand_visual_briefs"[\s\S]*share\s+row\s+exclusive/i
    );
    expect(sql).toMatch(
      /insert\s+into\s+"career_mcp"\."brand_brief_source_claims"[\s\S]*select[\s\S]*from\s+"career_mcp"\."brand_visual_briefs"/i
    );
    expect(sql).toMatch(/brand_brief_source_claim_backfill[\s\S]*raise\s+exception/i);
    expect(sql).toMatch(
      /after\s+insert[\s\S]*on\s+"career_mcp"\."brand_visual_briefs"[\s\S]*claim_brand_brief_source/i
    );
    expect(sql).toMatch(
      /before\s+update\s+of\s+"owner_subject",\s*"post_draft_id",\s*"post_version"[\s\S]*keep_brand_brief_source_immutable/i
    );
    expect(sql).toMatch(
      /before\s+update\s+or\s+delete[\s\S]*on\s+"career_mcp"\."brand_brief_source_claims"[\s\S]*reject_brand_brief_source_claim_mutation/i
    );
    expect(sql.match(/security\s+definer/gi)).toHaveLength(1);
    expect(sql.match(/security\s+invoker/gi)).toHaveLength(2);
    expect(sql.match(/set\s+search_path\s*=\s*''/gi)).toHaveLength(3);
    expect(sql.match(/revoke\s+all\s+on\s+function[\s\S]*?from\s+public/gi))
      .toHaveLength(3);
    expect(sql).toMatch(
      /revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+table\s+"career_mcp"\."brand_brief_source_claims"\s+from\s+career_mcp_runtime/i
    );
    expect(sql).toMatch(
      /grant\s+select\s+on\s+table\s+"career_mcp"\."brand_brief_source_claims"\s+to\s+career_mcp_runtime/i
    );
    expect(sql).not.toMatch(/\bgrant\b[\s\S]{0,100}\b(?:anon|authenticated|service_role)\b/i);
    expect(sql).not.toMatch(/storage\s*\.\s*(?:buckets|objects)/i);
  });

  it("records the brand brief source claim table and complete foreign-key indexes", async () => {
    const snapshot = await brandBriefSourceClaimsSnapshot();

    expect(snapshot).toMatch(/career_mcp\.brand_brief_source_claims/i);
    expect(snapshot).toMatch(/brand_brief_source_claims_brief_id_brand_visual_briefs_id_fk/i);
    expect(snapshot).toMatch(/brand_brief_source_claims_post_version_fk/i);
    expect(snapshot).toMatch(/brand_brief_source_claims_owner_subject_idx/i);
    expect(snapshot).toMatch(/brand_brief_source_claims_post_version_idx/i);
  });

  it("fails closed when a reused runtime role belongs to any parent role", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/pg_catalog\.pg_auth_members/i);
    expect(sql).toMatch(/member_role\.rolname\s*=\s*'career_mcp_runtime'/i);
    expect(sql).toMatch(/raise\s+exception[\s\S]*role membership/i);
  });
});
