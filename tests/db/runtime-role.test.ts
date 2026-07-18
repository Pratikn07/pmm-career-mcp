import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function runtimeRoleSql(): Promise<string> {
  return await readFile(resolve("supabase/runtime-role.sql"), "utf8");
}

describe("Supabase runtime-role operator template", () => {
  it("creates an idempotent least-privilege NOINHERIT login and prompts privately for its password", async () => {
    const sql = await runtimeRoleSql();

    expect(sql).toMatch(/where\s+rolname\s*=\s*'career_mcp_runtime'/i);
    expect(sql).toMatch(/create\s+role\s+career_mcp_runtime/i);
    expect(sql).toMatch(/alter\s+role\s+career_mcp_runtime[\s\S]*noinherit[\s\S]*login/i);
    expect(sql).toMatch(/\\password\s+career_mcp_runtime/i);
    expect(sql).not.toMatch(/password\s+['"][^'"]+['"]/i);
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
});
