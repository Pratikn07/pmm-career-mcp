import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app.js";

it("serves the deterministic review-card client with exact safe headers", async () => {
  const app = createHttpApp({ mcpHandler: (_request, response) => response.sendStatus(204) });

  const response = await request(app).get("/review-card-client.js");

  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toMatch(/^application\/javascript/);
  expect(response.headers["cache-control"]).toBe("no-cache");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers.location).toBeUndefined();
  expect(response.text).not.toMatch(/DATABASE_URL|TOKEN_ENCRYPTION_KEY|SUPABASE_PUBLISHABLE_KEY|LINKEDIN_CLIENT_SECRET/);
});

it("uses safe DOM operations and no executable third-party content", async () => {
  const source = await readFile(resolve(process.cwd(), "src/review-card/client.ts"), "utf8");

  expect(source).toContain("getToolResponseMetadata");
  expect(source).toContain('"openai:set_globals"');
  expect(source).toContain("data-storage-origin");
  expect(source).toContain("referrerPolicy = \"no-referrer\"");
  expect(source).toContain("image.alt = item.altText");
  expect(source).toContain("safePostId.textContent = view.postId");
  expect(source).toContain("safeBrandSeries.textContent = view.brand.seriesName");
  expect(source).toContain("safeBrandTemplate.textContent");
  expect(source).toContain("safeBrandHook.textContent = view.brand.coverHook");
  expect(source).toContain("abbreviatedChecksum(view.brand.renderChecksum)");
  expect(source).toContain("safeBrandValidation.textContent");
  expect(source).toContain("safeValidationStatus.textContent");
  expect(source).toContain("replaceChildren");
  expect(source).toContain("textContent");
  expect(source).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(/);
  expect(source).not.toMatch(/https?:\/\//);
  expect(source).not.toMatch(/approvalCapability.*(?:console|textContent)/s);
  expect(source).not.toMatch(/(?:sourceMediaId|objectPath|signedUrl).*textContent/s);
});

it("builds a minified IIFE review-card bundle without a source map", async () => {
  const bundle = await readFile(resolve(process.cwd(), "dist/public/review-card-client.js"), "utf8");

  expect(bundle.length).toBeGreaterThan(0);
  expect(bundle).not.toContain("sourceMappingURL");
  expect(bundle).not.toMatch(/^\s*(?:import|export)\s/m);
  expect(bundle).not.toContain("LINKEDIN_CLIENT_SECRET");
});
