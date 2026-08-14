import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app.js";
import {
  createBrandedVisualBriefOutput,
  renderBrandedLinkedInCoverOutput
} from "../../src/mcp/schemas.js";

function app() {
  return createHttpApp({ mcpHandler: (_request, response) => response.sendStatus(501) });
}

it("returns a sanitized MCP error and propagates a safe request ID for malformed JSON", async () => {
  const token = "raw-bearer-token-that-must-not-enter-the-response";
  const response = await request(app())
    .post("/mcp")
    .set("content-type", "application/json")
    .set("authorization", `Bearer ${token}`)
    .set("X-Request-Id", "mcp_test_request_7")
    .send('{"incomplete":');

  expect(response.status).toBe(400);
  expect(response.headers["x-request-id"]).toBe("mcp_test_request_7");
  expect(response.body).toEqual({ error: "MCP request could not be completed" });
  expect(response.text).not.toMatch(/syntax|unexpected|\/Users\//i);
  expect(response.text).not.toContain(token);
});

it("bounds oversized MCP JSON bodies and still includes a generated request ID", async () => {
  const response = await request(app())
    .post("/mcp")
    .set("content-type", "application/json")
    .send(`{"payload":"${"x".repeat(1_048_576)}"}`);

  expect(response.status).toBe(413);
  expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.body).toEqual({ error: "MCP request could not be completed" });
  expect(response.text).not.toMatch(/entity\.too\.large|\/Users\//i);
});

it("keeps Brand Studio output contracts closed to private transport and approval fields", () => {
  const forbidden = {
    objectPath: "owner/private.png",
    signedUrl: "https://storage.example/private",
    sourceDownloadUrl: "https://files.example/private",
    jwt: "private-jwt",
    fontPath: "/private/font.woff2",
    approvalCapability: "A".repeat(43)
  };
  const brief = {
    data: {
      brief: {
        id: "brief-1",
        postId: "post-1",
        postVersion: 1,
        profileVersion: 1,
        templateId: "editorial-statement-v1",
        templateVersion: 1,
        promptFormatVersion: 1,
        visualMode: "EDITORIAL_STATEMENT",
        coverHook: "Clarity beats capability.",
        conceptSummary: "A restrained editorial idea",
        topicLabel: null,
        generationPrompt: "Create text-free restrained abstract editorial geometry.",
        negativeConstraints: ["readable text", "logos"],
        state: "ready",
        createdAt: "2026-07-17T00:00:00.000Z",
        ...forbidden
      },
      requiresSourceImage: false,
      proposedAltText: "Editorial PMM Field Notes cover about clarity."
    }
  };
  const render = {
    data: {
      post: {
        id: "post-1",
        versionId: "version-2",
        text: "Post text",
        visibility: "PUBLIC",
        version: 2,
        checksum: "a".repeat(64),
        state: "draft",
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
        media: []
      },
      provenance: {
        seriesName: "PMM FIELD NOTES",
        profileVersion: 1,
        templateId: "editorial-statement-v1",
        templateVersion: 1,
        coverHook: "Clarity beats capability.",
        renderChecksum: "b".repeat(64),
        validationPassed: true,
        validation: {
          fixedLabelsPresent: true,
          textWithinSafeArea: true,
          sourceImageUsed: false
        },
        ...forbidden
      }
    }
  };

  expect(createBrandedVisualBriefOutput.safeParse(brief).success).toBe(false);
  expect(renderBrandedLinkedInCoverOutput.safeParse(render).success).toBe(false);
});
