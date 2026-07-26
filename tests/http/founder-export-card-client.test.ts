import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app.js";

it("serves the founder export card client with no-cache and nosniff headers", async () => {
  const app = createHttpApp({ mcpHandler: (_request, response) => response.sendStatus(204) });

  const response = await request(app).get("/founder-export-card-client.js");

  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toMatch(/^application\/javascript/);
  expect(response.headers["cache-control"]).toBe("no-cache");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers.location).toBeUndefined();
  expect(response.text).not.toMatch(/DATABASE_URL|TOKEN_ENCRYPTION_KEY|SUPABASE_PUBLISHABLE_KEY|LINKEDIN_CLIENT_SECRET/);
});

it("keeps the export client DOM-only and private-metadata-only", async () => {
  const source = await readFile(resolve(process.cwd(), "src/founder-export-card/client.ts"), "utf8");

  expect(source).toContain("toolResponseMetadata");
  expect(source).toContain('"openai:set_globals"');
  expect(source).toContain("textContent");
  expect(source).toContain("window.open");
  expect(source).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(/u);
  expect(source).not.toMatch(/callTool|linkedin|https?:\/\//iu);
});

it("builds a minified IIFE founder export bundle without a source map", async () => {
  const bundle = await readFile(resolve(process.cwd(), "dist/public/founder-export-card-client.js"), "utf8");

  expect(bundle.length).toBeGreaterThan(0);
  expect(bundle).not.toContain("sourceMappingURL");
  expect(bundle).not.toMatch(/^\s*(?:import|export)\s/mu);
  expect(bundle).not.toContain("LINKEDIN_CLIENT_SECRET");
  expect(bundle).not.toMatch(/callTool|linkedin/iu);
});
