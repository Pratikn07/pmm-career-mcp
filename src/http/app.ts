import express, { type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "../config.js";
import { createResourceAuth, protectedResourceMetadata } from "../auth/resource-auth.js";

type CommonHttpDependencies = {
  /** Required by hosted OAuth deployments; omitted only for existing local test handlers. */
  config?: AppConfig;
};

type LegacyHttpDependencies = CommonHttpDependencies & {
  mcpHandler: RequestHandler;
};

type StreamableMcpDependencies = CommonHttpDependencies & {
  /** A fresh server prevents one stateless request leaking state into another. */
  mcpServerFactory: () => McpServer;
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

function streamableMcpHandler(factory: () => McpServer): RequestHandler {
  return async (request, response) => {
    let server: McpServer | undefined;
    try {
      server = factory();
      // SDK 1.29's declaration omits `undefined`, although it is the documented
      // and runtime-supported stateless setting.
      const transport = new StreamableHTTPServerTransport(
        { sessionIdGenerator: undefined } as never
      );
      response.once("finish", () => { void server?.close(); });
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({ error: "MCP request could not be completed" });
      }
      await server?.close();
    }
  };
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
  if (deps.config !== undefined && deps.config.authMode === "oauth") {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.json(protectedResourceMetadata(deps.config!));
    });
  }
  app.all("/mcp", "mcpHandler" in deps ? deps.mcpHandler : streamableMcpHandler(deps.mcpServerFactory));
  app.use(mcpJsonBodyError);

  return app;
}
