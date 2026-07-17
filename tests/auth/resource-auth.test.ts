import { createServer, type Server } from "node:http";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createResourceAuth, protectedResourceMetadata } from "../../src/auth/resource-auth.js";

type IssuerFixture = {
  issuer: string;
  config: AppConfig;
  server: Server;
  key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  token(overrides?: { audience?: string; subject?: string; expiresIn?: string }): Promise<string>;
  tokenWithoutExpiry(): Promise<string>;
};

async function startIssuer(): Promise<IssuerFixture> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  const issuerApp = express();
  const server = createServer(issuerApp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test issuer address");
  const issuer = `http://127.0.0.1:${address.port}`;
  issuerApp.get("/.well-known/openid-configuration", (_request, response) => {
    response.json({ issuer, jwks_uri: `${issuer}/jwks` });
  });
  issuerApp.get("/jwks", (_request, response) => response.json({ keys: [publicJwk] }));

  return {
    issuer,
    config: loadConfig({
      NODE_ENV: "test",
      AUTH_MODE: "oauth",
      BASE_URL: "http://127.0.0.1:3000/",
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: "http://127.0.0.1:3000",
      ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
      TOKEN_ENCRYPTION_KEY: "a".repeat(64)
    }),
    server,
    key: privateKey,
    token: async (overrides = {}) => new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(overrides.audience ?? "http://127.0.0.1:3000")
      .setSubject(overrides.subject ?? "123e4567-e89b-12d3-a456-426614174000")
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey),
    tokenWithoutExpiry: async () => new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("http://127.0.0.1:3000")
      .setSubject("123e4567-e89b-12d3-a456-426614174000")
      .setIssuedAt()
      .sign(privateKey)
  };
}

describe("protected resource authentication", () => {
  let fixture: IssuerFixture;

  beforeAll(async () => { fixture = await startIssuer(); });
  afterAll(async () => { await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve())); });

  it("publishes canonical protected-resource metadata", () => {
    expect(protectedResourceMetadata(fixture.config)).toEqual({
      resource: "http://127.0.0.1:3000",
      authorization_servers: [fixture.issuer],
      scopes_supported: ["openid", "email"],
      resource_documentation: "http://127.0.0.1:3000/docs"
    });
  });

  it("refuses a credentialed resource URL before protected-resource metadata can expose it", () => {
    expect(() => protectedResourceMetadata({
      ...fixture.config,
      baseUrl: "https://metadata-user:metadata-password@career.example"
    })).toThrow(/credentials/);
  });

  it("refuses a credentialed authorization server before metadata can expose it", () => {
    expect(() => protectedResourceMetadata({
      ...fixture.config,
      oidcIssuer: "https://issuer-user:issuer-password@issuer.example"
    })).toThrow(/credentials/);
  });

  it("accepts a correctly signed, issuer-bound, audience-bound token for the configured subject", async () => {
    const app = express();
    app.use(createResourceAuth(fixture.config));
    app.get("/protected", (_request, response) => response.json({ ok: true }));

    const response = await request(app).get("/protected").set("authorization", `Bearer ${await fixture.token()}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("returns generic responses for missing, invalid, expired, and unauthorized-subject tokens", async () => {
    const app = express();
    app.use(createResourceAuth(fixture.config));
    app.get("/protected", (_request, response) => response.json({ ok: true }));

    const cases = [
      { label: "missing", token: undefined, status: 401 },
      { label: "wrong audience", token: await fixture.token({ audience: "other" }), status: 401 },
      { label: "expired", token: await fixture.token({ expiresIn: "-1s" }), status: 401 },
      { label: "missing expiry", token: await fixture.tokenWithoutExpiry(), status: 401 },
      { label: "wrong subject", token: await fixture.token({ subject: "someone-else" }), status: 401 }
    ] as const;

    for (const candidate of cases) {
      const response = await request(app)
        .get("/protected")
        .set(candidate.token === undefined ? {} : { authorization: `Bearer ${candidate.token}` });
      expect(response.status, candidate.label).toBe(candidate.status);
      expect(response.body, candidate.label).toEqual({ error: "Access to this MCP resource is denied" });
      expect(response.text, candidate.label).not.toMatch(/123e4567|someone-else|aud|claim|jwt|expired/i);
    }
  });

  it("rejects an insecure JWKS location for production without leaking the discovery failure", async () => {
    const productionConfig: AppConfig = {
      ...fixture.config,
      nodeEnv: "production",
      baseUrl: "https://career.example",
      oidcIssuer: "https://issuer.example",
      oidcAudience: "https://career.example"
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: "https://issuer.example",
      jwks_uri: "http://127.0.0.1:9999/jwks"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const app = express();
    app.use(createResourceAuth(productionConfig));
    app.get("/protected", (_request, response) => response.json({ ok: true }));

    try {
      const response = await request(app).get("/protected").set("authorization", `Bearer ${await fixture.token()}`);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Access to this MCP resource is denied" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
