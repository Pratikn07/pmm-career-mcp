import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
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
    ["OIDC_ISSUER", { OIDC_AUDIENCE: "career-mcp", ALLOWED_SUBJECT: "user-123", TOKEN_ENCRYPTION_KEY: "a".repeat(64) }],
    ["OIDC_AUDIENCE", { OIDC_ISSUER: "https://issuer.example", ALLOWED_SUBJECT: "user-123", TOKEN_ENCRYPTION_KEY: "a".repeat(64) }],
    ["ALLOWED_SUBJECT", { OIDC_ISSUER: "https://issuer.example", OIDC_AUDIENCE: "career-mcp", TOKEN_ENCRYPTION_KEY: "a".repeat(64) }],
    ["TOKEN_ENCRYPTION_KEY", { OIDC_ISSUER: "https://issuer.example", OIDC_AUDIENCE: "career-mcp", ALLOWED_SUBJECT: "user-123" }],
    ["BASE_URL", { OIDC_ISSUER: "https://issuer.example", OIDC_AUDIENCE: "career-mcp", ALLOWED_SUBJECT: "user-123", TOKEN_ENCRYPTION_KEY: "a".repeat(64), BASE_URL: "http://localhost:3000" }]
  ])("fails closed in production without %s", (missing, values) => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "oauth", ...values })).toThrow(missing);
  });

  it("allows AUTH_MODE=none only outside production", () => {
    expect(loadConfig({ NODE_ENV: "test", AUTH_MODE: "none" }).authMode).toBe("none");
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "none" })).toThrow(/AUTH_MODE/);
  });
});
