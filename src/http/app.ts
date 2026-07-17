import express, { type Express, type RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type LegacyHttpDependencies = {
  mcpHandler: RequestHandler;
};

type StreamableMcpDependencies = {
  /** A fresh server prevents one stateless request leaking state into another. */
  mcpServerFactory: () => McpServer;
};

export type HttpDependencies = LegacyHttpDependencies | StreamableMcpDependencies;

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
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.all("/mcp", "mcpHandler" in deps ? deps.mcpHandler : streamableMcpHandler(deps.mcpServerFactory));

  return app;
}
