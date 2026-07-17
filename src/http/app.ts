import express, { type Express, type RequestHandler } from "express";

export type HttpDependencies = {
  mcpHandler: RequestHandler;
};

export function createHttpApp(deps: HttpDependencies): Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.all("/mcp", deps.mcpHandler);

  return app;
}
