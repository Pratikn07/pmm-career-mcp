import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import {
  LINKEDIN_REVIEW_CARD_URI,
  registerLinkedInReviewCardResource
} from "../../src/review-card/resource.js";

it("serves a self-contained semantic review-card shell with minimal canonical CSP", async () => {
  const server = new McpServer({ name: "resource-test", version: "1.0.0" });
  registerLinkedInReviewCardResource(server, {
    baseUrl: "https://mcp.example",
    supabaseUrl: "https://project.supabase.co"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listResources();
  const result = await client.readResource({ uri: LINKEDIN_REVIEW_CARD_URI });
  await Promise.all([client.close(), server.close()]);

  expect(listed.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({
      uri: LINKEDIN_REVIEW_CARD_URI,
      mimeType: "text/html+skybridge",
      _meta: expect.objectContaining({
        ui: expect.objectContaining({ domain: "https://mcp.example" }),
        "openai/widgetDomain": "https://mcp.example"
      })
    })
  ]));
  expect(result.contents).toHaveLength(1);
  const resource = result.contents[0] as { mimeType?: string; text?: string; _meta?: Record<string, unknown> };
  expect(resource.mimeType).toBe("text/html+skybridge");
  expect(resource._meta).toMatchObject({
    ui: {
      domain: "https://mcp.example",
      csp: {
        connectDomains: ["https://mcp.example", "https://project.supabase.co"],
        resourceDomains: ["https://mcp.example", "https://project.supabase.co"]
      }
    },
    "openai/widgetDomain": "https://mcp.example",
    "openai/widgetCSP": {
      connect_domains: ["https://mcp.example", "https://project.supabase.co"],
      resource_domains: ["https://mcp.example", "https://project.supabase.co"]
    }
  });

  const html = resource.text ?? "";
  expect(html).toMatch(/#post-text\s*\{[^}]*white-space:\s*pre-wrap/i);
  expect(html).toContain('src="https://mcp.example/review-card-client.js"');
  expect(html).toContain('data-storage-origin="https://project.supabase.co"');
  for (const id of [
    "post-text",
    "post-visibility",
    "post-media",
    "post-id",
    "post-version",
    "post-checksum",
    "preview-expiry",
    "validation-status",
    "validation-errors",
    "create-preview",
    "publish-post",
    "publish-confirmation"
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain("<dialog");
  expect(html.match(/https?:\/\//g)).toHaveLength(2);
  expect(html).not.toMatch(/<script[^>]+src=(?!"https:\/\/mcp\.example\/review-card-client\.js")/i);
  expect(html).not.toMatch(/on(?:click|load|error)=/i);
});

it.each([
  { baseUrl: "https://mcp.example/path", supabaseUrl: "https://project.supabase.co" },
  { baseUrl: "https://mcp.example", supabaseUrl: "https://user@project.supabase.co" },
  { baseUrl: "http://mcp.example", supabaseUrl: "https://project.supabase.co" }
])("rejects non-canonical review-card origins", (origins) => {
  const server = new McpServer({ name: "resource-test", version: "1.0.0" });
  expect(() => registerLinkedInReviewCardResource(server, origins)).toThrow();
});
