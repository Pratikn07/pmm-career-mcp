import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";

const validAuthorizationId = "123e4567-e89b-42d3-a456-426614174000";

function oauthConfig() {
  return loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "oauth",
    BASE_URL: "http://127.0.0.1:3000",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_PUBLISHABLE_KEY: "public-key-</script><img>",
    OIDC_ISSUER: "http://127.0.0.1:54321/auth/v1",
    OIDC_AUDIENCE: "http://127.0.0.1:3000",
    ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
    TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    DATABASE_URL: "postgresql://user:database-password@localhost/database"
  });
}

describe("Supabase OAuth consent page", () => {
  it("renders only escaped public configuration for a valid authorization id", async () => {
    const app = createHttpApp({ config: oauthConfig(), mcpHandler: (_request, response) => response.sendStatus(204) });

    const response = await request(app).get(`/oauth/consent?authorization_id=${validAuthorizationId}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('data-supabase-url="http://127.0.0.1:54321"');
    expect(response.text).toContain("public-key-&lt;/script&gt;&lt;img&gt;");
    expect(response.text).not.toContain("database-password");
    expect(response.text).not.toContain("TOKEN_ENCRYPTION_KEY");
    expect(response.text).not.toContain("ALLOWED_SUBJECT");
    expect(response.text).not.toContain("authorization_id=");
    expect(response.text).toContain('src="/oauth/consent-client.js"');
  });

  it("returns a generic safe page for a missing or malformed authorization id", async () => {
    const app = createHttpApp({ config: oauthConfig(), mcpHandler: (_request, response) => response.sendStatus(204) });

    for (const path of ["/oauth/consent", "/oauth/consent?authorization_id=not-an-id"]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(400);
      expect(response.text).toContain("Unable to continue authorization.");
      expect(response.text).not.toContain("not-an-id");
      expect(response.text).not.toContain("public-key");
    }
  });

  it("is unavailable unless OAuth and public Supabase configuration are enabled", async () => {
    const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "none" });
    const app = createHttpApp({ config, mcpHandler: (_request, response) => response.sendStatus(204) });

    expect((await request(app).get(`/oauth/consent?authorization_id=${validAuthorizationId}`)).status).toBe(404);
  });

  it("uses a restrictive CSP and security headers without third-party assets", async () => {
    const app = createHttpApp({ config: oauthConfig(), mcpHandler: (_request, response) => response.sendStatus(204) });

    const response = await request(app).get(`/oauth/consent?authorization_id=${validAuthorizationId}`);

    expect(response.headers["content-security-policy"]).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:54321; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toMatch(/<(?:script|link)[^>]+https?:\/\//i);
  });

  it("serves the local client bundle with immutable cache headers", async () => {
    const app = createHttpApp({ config: oauthConfig(), mcpHandler: (_request, response) => response.sendStatus(204) });

    const response = await request(app).get("/oauth/consent-client.js");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/javascript/);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers.location).toBeUndefined();
  });
});
