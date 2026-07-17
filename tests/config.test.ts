import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
    ["OIDC_ISSUER", "https://other.supabase.co/auth/v1", /OIDC_ISSUER.*SUPABASE_URL/],
    ["OIDC_AUDIENCE", "https://other.example", /OIDC_AUDIENCE.*BASE_URL/],
    ["ALLOWED_SUBJECT", "user-123", /ALLOWED_SUBJECT.*UUID/]
  ])("rejects an invalid production %s", (key, value, expected) => {
    expect(() => loadConfig({ ...productionConfig, [key]: value })).toThrow(expected);
  });

  it("rejects removed DATABASE_PATH configuration in production", () => {
    expect(() => loadConfig({ ...productionConfig, DATABASE_PATH: "./career.db" })).toThrow(/DATABASE_PATH/);
  });

  it("normalizes the canonical public URLs for OAuth configuration", () => {
    const config = loadConfig(productionConfig);
    expect(config.baseUrl).toBe("https://career.example");
    expect(config.supabaseUrl).toBe("https://project.supabase.co");
    expect(config.oidcAudience).toBe(config.baseUrl);
    expect(config.oidcIssuer).toBe("https://project.supabase.co/auth/v1");
  });
});
