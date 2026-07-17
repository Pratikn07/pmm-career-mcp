import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createCareerMcpServer, type CareerMcpDependencies } from "../../src/mcp/server.js";
import { createHttpApp } from "../../src/http/app.js";
import request from "supertest";

const expectedTools = [
  "search_yc_companies",
  "discover_public_people",
  "find_pmm_opportunities",
  "rank_networking_targets",
  "explain_target_match",
  "draft_outreach",
  "draft_linkedin_post",
  "revise_post",
  "preview_post",
  "create_weekly_shortlist",
  "save_target",
  "update_outreach_status",
  "list_pipeline",
  "record_note",
  "list_post_history",
  "get_linkedin_connection_status",
  "create_linkedin_authorization_url",
  "publish_linkedin_post"
] as const;

function dependencies(): CareerMcpDependencies {
  return {
    ycProvider: { searchYcCompanies: async () => [] },
    peopleDiscovery: { discoverPublicPeople: async () => ({
      people: [], evidence: [], checkedAt: "2026-07-17T00:00:00.000Z", coverage: "authoritative-pages-only", warnings: []
    }) },
    jobDiscovery: { findPmmOpportunities: async () => ({
      opportunities: [], checkedAt: "2026-07-17T00:00:00.000Z", warnings: []
    }) },
    pipeline: {
      saveTarget: () => { throw new Error("not called"); },
      updateStatus: () => { throw new Error("not called"); },
      recordNote: () => { throw new Error("not called"); },
      listPipeline: () => [],
      createShortlist: () => { throw new Error("not called"); }
    },
    drafts: {
      createOutreach: () => { throw new Error("not called"); },
      createPost: () => { throw new Error("not called"); },
      revisePost: () => { throw new Error("not called"); },
      getPostHistory: () => []
    },
    previews: { create: () => { throw new Error("not called"); } },
    publish: { publish: async () => ({ state: "publish_failed" as const }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: () => ({ connected: false, valid: false, publishingEnabled: false })
  };
}

async function listTools() {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await Promise.all([client.close(), server.close()]);
  return result.tools;
}

it("registers exactly the approved Career MCP tools", async () => {
  const tools = await listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
  expect(tools.map((tool) => tool.name).some((name) => /scrape|message|profile|schedule|batch/.test(name))).toBe(false);
  expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
});

it("makes the four publishing and research safety rules prominent in instructions", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const instructions = client.getInstructions() ?? "";
  await Promise.all([client.close(), server.close()]);
  expect(instructions.slice(0, 512)).toContain("Never fetch LinkedIn for research");
  expect(instructions.slice(0, 512)).toContain("Never claim complete employee coverage");
  expect(instructions.slice(0, 512)).toContain("current user explicitly asks to publish the exact preview");
  expect(instructions.slice(0, 512)).toContain("Never batch or retry publishing");
});

it("serves MCP initialization through stateless Streamable HTTP", async () => {
  const response = await request(createHttpApp({ mcpServerFactory: () => createCareerMcpServer(dependencies()) }))
    .post("/mcp")
    .set("accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });
  expect(response.status).toBe(200);
  expect(response.text).toContain('"name":"pmm-career-mcp"');
  expect(response.headers["mcp-session-id"]).toBeUndefined();
});

it("returns a safe tool error without exposing an implementation message", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "A safe test post", visibility: "PUBLIC" }
  });
  await Promise.all([client.close(), server.close()]);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("not called");
});
