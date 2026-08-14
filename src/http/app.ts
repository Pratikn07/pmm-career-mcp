import express, { type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "../config.js";
import { createResourceAuth, protectedResourceMetadata } from "../auth/resource-auth.js";
import {
  REQUEST_AUTH_CONTEXT,
  type AuthenticatedLocals,
  type RequestAuthContext
} from "../auth/request-context.js";
import { applyConsentSecurityHeaders, hasConsentPageConfiguration, invalidConsentPage, renderConsentPage } from "../oauth/consent-page.js";
import { isSupabaseAuthorizationId } from "../oauth/authorization-id.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type CommonHttpDependencies = {
  /** Required by hosted OAuth deployments; omitted only for existing local test handlers. */
  config?: AppConfig;
  /** A lightweight query that confirms the migrated database is reachable. */
  checkReady?: () => Promise<void>;
};

type LegacyHttpDependencies = CommonHttpDependencies & {
  mcpHandler: RequestHandler;
};

type StreamableMcpDependencies = CommonHttpDependencies & {
  /** A fresh server prevents one stateless request leaking state into another. */
  mcpServerFactory: (context: RequestAuthContext | undefined) => McpServer;
};

export type HttpDependencies = LegacyHttpDependencies | StreamableMcpDependencies;

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function requestIdFor(value: string | undefined): string {
  return value !== undefined
    && value.length <= MAX_REQUEST_ID_LENGTH
    && REQUEST_ID_PATTERN.test(value)
    ? value
    : randomUUID();
}

const mcpRequestId: RequestHandler = (request, response, next) => {
  response.setHeader("X-Request-Id", requestIdFor(request.get("X-Request-Id")));
  next();
};

function isJsonBodyError(error: unknown): error is { status?: unknown; type?: unknown } {
  return typeof error === "object"
    && error !== null
    && ((error as { type?: unknown }).type === "entity.parse.failed"
      || (error as { type?: unknown }).type === "entity.too.large");
}

const mcpJsonBodyError: ErrorRequestHandler = (error, request, response, next) => {
  if (request.path !== "/mcp" || !isJsonBodyError(error)) {
    next(error);
    return;
  }
  if (!response.headersSent) {
    const status = error.type === "entity.too.large" ? 413 : 400;
    response.status(status).json({ error: "MCP request could not be completed" });
  }
};

function streamableMcpHandler(
  factory: (context: RequestAuthContext | undefined) => McpServer
): RequestHandler {
  return async (request, response) => {
    let server: McpServer | undefined;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const locals: AuthenticatedLocals = response.locals;
      server = factory(locals[REQUEST_AUTH_CONTEXT]);
      closeServer = registerMcpServerCleanup(response, server);
      // SDK 1.29's declaration omits `undefined`, although it is the documented
      // and runtime-supported stateless setting.
      const transport = new StreamableHTTPServerTransport(
        { sessionIdGenerator: undefined } as never
      );
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({ error: "MCP request could not be completed" });
      }
      await closeServer?.();
    }
  };
}

/** Closes a stateless per-request MCP server once, regardless of response termination order. */
export function registerMcpServerCleanup(
  response: Pick<express.Response, "once">,
  server: Pick<McpServer, "close">
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    closePromise ??= Promise.resolve(server.close()).catch(() => undefined);
    return closePromise;
  };
  response.once("finish", () => { void closeOnce(); });
  response.once("close", () => { void closeOnce(); });
  return closeOnce;
}

export function createHttpApp(deps: HttpDependencies): Express {
  const app = express();
  // This runs before body parsing so malformed and too-large body responses
  // receive the same correlation header as normal MCP responses.
  app.use("/mcp", mcpRequestId);
  // Authenticate before parsing a potentially large or malformed MCP body.
  // The public metadata route is registered below and is deliberately outside
  // this path-scoped middleware.
  if (deps.config !== undefined && deps.config.authMode === "oauth") {
    app.use("/mcp", createResourceAuth(deps.config));
  }
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.get("/ready", async (_request, response) => {
    if (deps.checkReady === undefined) {
      response.status(503).json({ status: "not_ready" });
      return;
    }
    try {
      await deps.checkReady();
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "not_ready" });
    }
  });
  app.get("/review-card-client.js", (_request, response) => {
    const publicDirectory = resolve(process.cwd(), "dist/public");
    if (!existsSync(resolve(publicDirectory, "review-card-client.js"))) {
      response.status(404).end();
      return;
    }
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.type("application/javascript").sendFile("review-card-client.js", {
      root: publicDirectory,
      dotfiles: "allow"
    });
  });
  const consentConfig = deps.config;
  if (consentConfig !== undefined && hasConsentPageConfiguration(consentConfig)) {
    app.get("/oauth/consent", (request, response) => {
      const authorizationId = typeof request.query.authorization_id === "string" ? request.query.authorization_id : undefined;
      if (authorizationId === undefined || !isSupabaseAuthorizationId(authorizationId)) {
        applyConsentSecurityHeaders(response);
        response.status(400).type("html").send(invalidConsentPage());
        return;
      }
      applyConsentSecurityHeaders(response, consentConfig.supabaseUrl);
      response.type("html").send(renderConsentPage(consentConfig, authorizationId));
    });
    app.get("/oauth/consent-client.js", (_request, response) => {
      const publicDirectory = resolve(process.cwd(), "dist/public");
      if (!existsSync(resolve(publicDirectory, "consent-client.js"))) {
        response.status(404).end();
        return;
      }
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.type("application/javascript").sendFile("consent-client.js", {
        root: publicDirectory,
        dotfiles: "allow"
      });
    });
  }
  if (deps.config !== undefined && deps.config.authMode === "oauth") {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.json(protectedResourceMetadata(deps.config!));
    });
  }
  app.all("/mcp", "mcpHandler" in deps ? deps.mcpHandler : streamableMcpHandler(deps.mcpServerFactory));
  app.use(mcpJsonBodyError);

  return app;
}
