import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { createCareerMcpServer, type CareerMcpDependencies } from "../../src/mcp/server.js";
import { createHttpApp } from "../../src/http/app.js";
import request from "supertest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
      listPipeline: async () => [],
      createShortlist: () => { throw new Error("not called"); }
    },
    drafts: {
      createOutreach: () => { throw new Error("not called"); },
      createPost: () => { throw new Error("not called"); },
      revisePost: () => { throw new Error("not called"); },
      getPostHistory: async () => []
    },
    previews: { create: () => { throw new Error("not called"); } },
    publish: { publish: async () => ({ state: "publish_failed" as const }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: async () => ({ connected: false, valid: false, publishingEnabled: false })
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

it("closes the stateless MCP server once after a Streamable HTTP response completes", async () => {
  const server = createCareerMcpServer(dependencies());
  const close = vi.spyOn(server, "close");
  const response = await request(createHttpApp({ mcpServerFactory: () => server }))
    .post("/mcp")
    .set("accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("reports page-scoped YC coverage even when a filtered search is empty", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "search_yc_companies",
    arguments: { keyword: "outside-the-fetched-facet" }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.structuredContent).toMatchObject({
    data: {
      companies: [],
      coverageSummary: {
        coverage: "authoritative-page-only",
        complete: false,
        sourceUrl: "https://www.ycombinator.com/companies/industry/marketing"
      }
    }
  });
  expect(JSON.stringify(result.structuredContent)).toContain(
    "An empty result is not proof that no matching YC company exists"
  );
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

it("waits for a database-backed service promise before returning a tool result", async () => {
  const post = deferred<{ id: string }>();
  const started = deferred<void>();
  const asyncDependencies = dependencies();
  asyncDependencies.drafts.createPost = (() => {
    started.resolve();
    return post.promise;
  }) as unknown as CareerMcpDependencies["drafts"]["createPost"];
  const server = createCareerMcpServer(asyncDependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let settled = false;
  const resultPromise = client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "An asynchronously saved post", visibility: "PUBLIC" }
  }).then((result) => {
    settled = true;
    return result;
  });
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  post.resolve({ id: "saved-post" });
  const result = await resultPromise;
  await Promise.all([client.close(), server.close()]);
  expect(result.structuredContent).toMatchObject({ data: { post: { id: "saved-post" } } });
});

it("turns a rejected database-backed service promise into a safe tool error", async () => {
  const asyncDependencies = dependencies();
  asyncDependencies.drafts.createPost = (async () => {
    throw new Error("database-connection-secret");
  }) as CareerMcpDependencies["drafts"]["createPost"];
  const server = createCareerMcpServer(asyncDependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "A safely failed post", visibility: "PUBLIC" }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ data: { error: { code: "DATA_INTEGRITY" } } });
  expect(JSON.stringify(result)).not.toContain("database-connection-secret");
});

it("keeps safe tool errors schema-valid over Streamable HTTP", async () => {
  const failingDependencies: CareerMcpDependencies = {
    ...dependencies(),
    ycProvider: { searchYcCompanies: async () => { throw new Error("provider-secret-detail"); } }
  };
  const listener = createHttpApp({ mcpServerFactory: () => createCareerMcpServer(failingDependencies) }).listen(0);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)) as never);
    const result = await client.callTool({ name: "search_yc_companies", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ data: { error: { code: "DATA_INTEGRITY" } } });
    expect(JSON.stringify(result)).not.toContain("provider-secret-detail");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
