import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import {
  FOUNDER_EXPORT_CARD_URI,
  registerFounderExportCardResource
} from "../../src/founder-export-card/resource.js";

it("serves the private founder export shell with one download control and an exact application CSP", async () => {
  const server = new McpServer({ name: "resource-test", version: "1.0.0" });
  registerFounderExportCardResource(server, { applicationUrl: "https://mcp.example" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listResources();
  const result = await client.readResource({ uri: FOUNDER_EXPORT_CARD_URI });
  await Promise.all([client.close(), server.close()]);

  expect(listed.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({
      uri: FOUNDER_EXPORT_CARD_URI,
      mimeType: "text/html+skybridge",
      _meta: expect.objectContaining({
        ui: {
          domain: "https://mcp.example",
          csp: {
            connectDomains: ["https://mcp.example"],
            resourceDomains: ["https://mcp.example"]
          }
        },
        "openai/widgetDomain": "https://mcp.example",
        "openai/widgetCSP": {
          connect_domains: ["https://mcp.example"],
          resource_domains: ["https://mcp.example"],
          redirect_domains: ["https://mcp.example"]
        }
      })
    })
  ]));
  const resource = result.contents[0] as { text?: string; _meta?: Record<string, unknown> };
  const html = resource.text ?? "";
  expect(resource._meta).toMatchObject({
    "openai/widgetDomain": "https://mcp.example",
    "openai/widgetCSP": {
      connect_domains: ["https://mcp.example"],
      resource_domains: ["https://mcp.example"],
      redirect_domains: ["https://mcp.example"]
    }
  });
  expect(html).toContain('src="https://mcp.example/founder-export-card-client.js"');
  expect(html).toContain('data-application-origin="https://mcp.example"');
  expect(html).toContain('id="download-excel"');
  expect(html.match(/<button\b/giu)).toHaveLength(1);
  expect(html).toContain("Download Excel");
  expect(html).toContain('id="export-run-id"');
  expect(html).toContain('id="export-created-at"');
  expect(html).toContain('id="export-expires-at"');
  expect(html).toContain('id="export-row-count"');
  expect(html).toContain('id="export-checksum"');
  expect(html).not.toMatch(/linkedin|callTool|on(?:click|load|error)=/iu);
  expect(html.match(/https?:\/\//gu)).toHaveLength(2);
});

it.each([
  "http://mcp.example",
  "https://mcp.example/path",
  "https://user:mcp.example",
  "https://mcp.example?query=value"
])("rejects a non-canonical application origin: %s", (applicationUrl) => {
  const server = new McpServer({ name: "resource-test", version: "1.0.0" });
  expect(() => registerFounderExportCardResource(server, { applicationUrl })).toThrow();
});
