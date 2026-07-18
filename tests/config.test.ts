import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function legacySupabaseKey(role: string): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.public-signature`;
}

describe("loadConfig", () => {
  const productionConfig = {
    NODE_ENV: "production" as const,
    AUTH_MODE: "oauth" as const,
    DATABASE_URL: "postgresql://postgres:postgres@db.example:5432/postgres",
    BASE_URL: "https://career.example/",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    OIDC_ISSUER: "https://project.supabase.co/auth/v1",
    OIDC_AUDIENCE: "https://career.example",
    ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
    TOKEN_ENCRYPTION_KEY: "a".repeat(64)
  };

  it("keeps publishing disabled by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.linkedinPublishEnabled).toBe(false);
  });

  it("rejects no-auth production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AUTH_MODE: "none",
      TOKEN_ENCRYPTION_KEY: "x".repeat(64)
    })).toThrow(/AUTH_MODE/);
  });

  it.each([
    "DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "OIDC_ISSUER", "OIDC_AUDIENCE", "ALLOWED_SUBJECT", "TOKEN_ENCRYPTION_KEY"
  ])("fails closed in production without %s", (missing) => {
    const values = { ...productionConfig } as Record<string, string>;
    delete values[missing];
    expect(() => loadConfig(values)).toThrow(missing);
  });

  it("allows AUTH_MODE=none only outside production", () => {
    expect(loadConfig({ NODE_ENV: "test", AUTH_MODE: "none" }).authMode).toBe("none");
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "none" })).toThrow(/AUTH_MODE/);
  });

  it("rejects an insecure OIDC issuer in production", () => {
    expect(() => loadConfig({
      ...productionConfig,
      OIDC_ISSUER: "http://project.supabase.co/auth/v1"
    })).toThrow(/OIDC_ISSUER.*HTTPS/);
  });

  it.each([
    ["DATABASE_URL", "mysql://db.example/career", /DATABASE_URL.*PostgreSQL/],
    ["SUPABASE_URL", "http://project.supabase.co", /SUPABASE_URL.*HTTPS/],
    ["BASE_URL", "https://mcp-user:mcp-password@career.example", /BASE_URL.*credentials/],
    ["SUPABASE_URL", "https://project-user:project-password@project.supabase.co", /SUPABASE_URL.*credentials/],
    ["SUPABASE_URL", "https://project.supabase.co/not-a-project-origin", /SUPABASE_URL.*project HTTPS origin/],
    ["OIDC_ISSUER", "https://other.supabase.co/auth/v1", /OIDC_ISSUER.*SUPABASE_URL/],
    ["OIDC_AUDIENCE", "https://other.example", /OIDC_AUDIENCE.*BASE_URL/],
    ["ALLOWED_SUBJECT", "user-123", /ALLOWED_SUBJECT.*UUID/]
  ])("rejects an invalid production %s", (key, value, expected) => {
    expect(() => loadConfig({ ...productionConfig, [key]: value })).toThrow(expected);
  });

  it("rejects removed DATABASE_PATH configuration in production", () => {
    expect(() => loadConfig({ ...productionConfig, DATABASE_PATH: "./career.db" })).toThrow(/DATABASE_PATH/);
  });

  it.each([
    "https://career.example/mcp",
    "https://career.example/nested/path/"
  ])("rejects a BASE_URL with a non-root path: %s", (baseUrl) => {
    expect(() => loadConfig({ NODE_ENV: "test", BASE_URL: baseUrl })).toThrow(/BASE_URL.*origin/);
  });

  it.each([
    "sb_publishable_example",
    legacySupabaseKey("anon")
  ])("accepts a browser-safe Supabase publishable key", (key) => {
    expect(loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: key }).supabasePublishableKey).toBe(key);
  });

  it.each([
    "sb_secret_example",
    legacySupabaseKey("service_role"),
    legacySupabaseKey("authenticated"),
    "not-a-supported-key",
    "header.invalid-base64.signature",
    "header.payload",
    ""
  ])("rejects an unsafe or malformed Supabase browser key", (key) => {
    expect(() => loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: key }))
      .toThrow(/SUPABASE_PUBLISHABLE_KEY.*publishable|SUPABASE_PUBLISHABLE_KEY.*anon/);
  });

  it.each(["development", "test", "production"] as const)("rejects Supabase secret keys in %s", (nodeEnv) => {
    const base = nodeEnv === "production" ? productionConfig : { NODE_ENV: nodeEnv };
    for (const secretName of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"] as const) {
      expect(() => loadConfig({ ...base, [secretName]: "secret-value" })).toThrow(/service-role keys/);
    }
  });

  it.each(["development", "test"] as const)("allows a local Supabase URL in %s", (nodeEnv) => {
    expect(loadConfig({
      NODE_ENV: nodeEnv,
      SUPABASE_URL: "http://127.0.0.1:54321/"
    }).supabaseUrl).toBe("http://127.0.0.1:54321");
  });

  it("normalizes the canonical public URLs for OAuth configuration", () => {
    const config = loadConfig(productionConfig);
    expect(config.baseUrl).toBe("https://career.example");
    expect(config.supabaseUrl).toBe("https://project.supabase.co");
    expect(config.oidcAudience).toBe(config.baseUrl);
    expect(config.oidcIssuer).toBe("https://project.supabase.co/auth/v1");
  });
});
