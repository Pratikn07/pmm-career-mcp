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

  it("grants only the existing and future application data access the runtime needs", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+career_mcp\s+to\s+career_mcp_runtime/i);
    expect(sql).toMatch(/grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+all\s+tables\s+in\s+schema\s+career_mcp/i);
    expect(sql).toMatch(/grant\s+usage,\s*select\s+on\s+all\s+sequences\s+in\s+schema\s+career_mcp/i);
    expect(sql).toMatch(/alter\s+default\s+privileges\s+in\s+schema\s+career_mcp/i);
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

  it("fails closed when a reused runtime role belongs to any parent role", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/pg_catalog\.pg_auth_members/i);
    expect(sql).toMatch(/member_role\.rolname\s*=\s*'career_mcp_runtime'/i);
    expect(sql).toMatch(/raise\s+exception[\s\S]*role membership/i);
  });
});
