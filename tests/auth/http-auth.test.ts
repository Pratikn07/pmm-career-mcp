import { createServer, type Server } from "node:http";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";

describe("MCP HTTP authentication", () => {
  let config: AppConfig;
  let issuer: string;
  let server: Server;
  let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "http-test-key";
    publicJwk.use = "sig";
    const issuerApp = express();
    server = createServer(issuerApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No test issuer address");
    issuer = `http://127.0.0.1:${address.port}`;
    issuerApp.get("/.well-known/openid-configuration", (_request, response) => response.json({ issuer, jwks_uri: `${issuer}/jwks` }));
    issuerApp.get("/jwks", (_request, response) => response.json({ keys: [publicJwk] }));
    config = loadConfig({
      NODE_ENV: "test", AUTH_MODE: "oauth", BASE_URL: "http://127.0.0.1:3000",
      OIDC_ISSUER: issuer, OIDC_AUDIENCE: "http://127.0.0.1:3000", ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000", TOKEN_ENCRYPTION_KEY: "a".repeat(64)
    });
  });

  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

  async function token(): Promise<string> {
    return new SignJWT({ scope: "openid email" })
      .setProtectedHeader({ alg: "RS256", kid: "http-test-key" })
      .setIssuer(issuer).setAudience("http://127.0.0.1:3000").setSubject("123e4567-e89b-12d3-a456-426614174000").setIssuedAt().setExpirationTime("5m")
      .sign(key);
  }

  it("keeps health and metadata public while requiring bearer auth on MCP", async () => {
    const app = createHttpApp({ config, mcpHandler: (_request, response) => response.sendStatus(204) });

    expect((await request(app).get("/health")).status).toBe(200);
    const metadata = await request(app).get("/.well-known/oauth-protected-resource");
    expect(metadata.status).toBe(200);
    expect(metadata.body.resource).toBe("http://127.0.0.1:3000");
    expect(metadata.body.scopes_supported).toEqual(["openid", "email"]);

    const rejected = await request(app).post("/mcp").set("X-Request-Id", "mcp_auth_1").send({});
    expect(rejected.status).toBe(401);
    expect(rejected.headers["x-request-id"]).toBe("mcp_auth_1");
    expect(rejected.headers["www-authenticate"]).toBe('Bearer resource_metadata="http://127.0.0.1:3000/.well-known/oauth-protected-resource" scope="openid email"');
    expect(rejected.body).toEqual({ error: "Access to this MCP resource is denied" });

    const accepted = await request(app).post("/mcp").set("authorization", `Bearer ${await token()}`).send({});
    expect(accepted.status).toBe(204);
  });
});
