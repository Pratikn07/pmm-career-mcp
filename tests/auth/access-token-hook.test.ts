import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../../supabase/migrations/20260717000000_mcp_audience_hook.sql"),
  "utf8"
);

describe("MCP audience access-token hook migration", () => {
  it("is idempotent and security invoker", () => {
    expect(migration).toMatch(/create\s+or\s+replace\s+function\s+public\.mcp_audience_access_token_hook/i);
    expect(migration).toMatch(/security\s+invoker/i);
  });

  it("copies only administrator-controlled app_metadata.mcp_audience into aud", () => {
    expect(migration).toMatch(/claims\s*->\s*'app_metadata'\s*->>\s*'mcp_audience'/i);
    expect(migration).toMatch(/jsonb_set\s*\(\s*claims\s*,\s*'\{aud\}'/i);
    expect(migration).not.toMatch(/user_metadata/i);
  });

  it("changes only OAuth tokens carrying a client_id", () => {
    expect(migration).toMatch(/claims\s*->>\s*'client_id'/i);
    expect(migration).toMatch(/client_id\s+is\s+null\s+or\s+client_id\s*=\s*''[\s\S]*return\s+jsonb_build_object/i);
  });

  it("sets the exact supported MCP scope from trusted hook logic", () => {
    expect(migration).toMatch(/jsonb_set\s*\([\s\S]*'\{scope\}'[\s\S]*to_jsonb\s*\(\s*'openid email'::text\s*\)/i);
    expect(migration).not.toMatch(/user_metadata|event\s*->>\s*'scope'/i);
  });

  it("preserves the subject and authenticated role claims required by Storage RLS", () => {
    const replacedClaimPaths = [...migration.matchAll(
      /jsonb_set\s*\(\s*claims\s*,\s*'\{([^}]+)\}'/gi
    )].map((match) => match[1]);

    expect(replacedClaimPaths).toEqual(["aud", "scope"]);
    expect(migration).toMatch(/return\s+jsonb_build_object\s*\(\s*'claims'\s*,\s*claims\s*\)/i);
  });

  it("permits execution only for Supabase Auth's admin role", () => {
    expect(migration).toMatch(/grant\s+usage\s+on\s+schema\s+public\s+to\s+supabase_auth_admin/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+function[\s\S]*from\s+public/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+function[\s\S]*from\s+anon/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+function[\s\S]*from\s+authenticated/i);
    expect(migration).toMatch(/grant\s+execute\s+on\s+function[\s\S]*to\s+supabase_auth_admin/i);
  });
});
