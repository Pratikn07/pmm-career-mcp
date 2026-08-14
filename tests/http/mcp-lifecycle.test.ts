import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import type { Response } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestAuthContext } from "../../src/auth/request-context.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createHttpApp, registerMcpServerCleanup } from "../../src/http/app.js";

describe("stateless MCP response lifecycle", () => {
  it.each(["finish", "close"] as const)("closes the per-request server on response %s", async (event) => {
    const response = new EventEmitter();
    const close = vi.fn(async () => undefined);

    registerMcpServerCleanup(response as unknown as Pick<Response, "once">, { close });
    response.emit(event);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("closes the per-request server exactly once when finish and close both fire", async () => {
    const response = new EventEmitter();
    const close = vi.fn(async () => undefined);

    registerMcpServerCleanup(response as unknown as Pick<Response, "once">, { close });
    response.emit("finish");
    response.emit("close");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});

describe("request-scoped MCP identity", () => {
  let config: AppConfig;
  let issuer: string;
  let issuerServer: Server;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "request-context-test-key";
    publicJwk.use = "sig";
    const issuerApp = express();
    issuerServer = createServer(issuerApp);
    await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
    const address = issuerServer.address();
    if (address === null || typeof address === "string") throw new Error("No test issuer address");
    issuer = `http://127.0.0.1:${address.port}`;
    issuerApp.get("/.well-known/openid-configuration", (_request, response) => response.json({
      issuer,
      jwks_uri: `${issuer}/jwks`
    }));
    issuerApp.get("/jwks", (_request, response) => response.json({ keys: [publicJwk] }));
    config = loadConfig({
      NODE_ENV: "test",
      AUTH_MODE: "oauth",
      BASE_URL: "http://127.0.0.1:3000",
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: "http://127.0.0.1:3000",
      ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
      TOKEN_ENCRYPTION_KEY: "a".repeat(64)
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => issuerServer.close((error) => error ? reject(error) : resolve()));
  });

  async function token(): Promise<string> {
    return new SignJWT({ scope: "openid email" })
      .setProtectedHeader({ alg: "RS256", kid: "request-context-test-key" })
      .setIssuer(issuer)
      .setAudience("http://127.0.0.1:3000")
      .setSubject("123e4567-e89b-12d3-a456-426614174000")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  it("passes the immutable authenticated context only to that request's stateless server", async () => {
    const captured: Array<RequestAuthContext | undefined> = [];
    const app = createHttpApp({
      config,
      mcpServerFactory: (context: RequestAuthContext | undefined) => {
        captured.push(context);
        return new McpServer({ name: "request-context-test", version: "1.0.0" });
      }
    });
    const firstToken = await token();
    const secondToken = await token();

    const responses = [];
    for (const [index, accessToken] of [firstToken, secondToken].entries()) {
      responses.push(await request(app)
        .post("/mcp")
        .set("accept", "application/json, text/event-stream")
        .set("authorization", `Bearer ${accessToken}`)
        .send({
          jsonrpc: "2.0",
          id: index + 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
          }
        }));
    }

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(firstToken).not.toBe(secondToken);
    expect(captured).toHaveLength(2);
    for (const [index, context] of captured.entries()) {
      expect(context?.subject).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(context?.accessToken === (index === 0 ? firstToken : secondToken)).toBe(true);
    }
    expect(captured.every((context) => Object.isFrozen(context))).toBe(true);
    for (const [index, response] of responses.entries()) {
      expect(response.text).not.toContain(index === 0 ? firstToken : secondToken);
    }
  });
});
