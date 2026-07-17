import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createCareerMcpServer, type CareerMcpDependencies } from "../../src/mcp/server.js";

function dependencies(): CareerMcpDependencies {
  return {
    ycProvider: { searchYcCompanies: async () => [] },
    peopleDiscovery: { discoverPublicPeople: async () => ({ people: [], evidence: [], checkedAt: "2026-07-17T00:00:00.000Z", coverage: "authoritative-pages-only", warnings: [] }) },
    jobDiscovery: { findPmmOpportunities: async () => ({ opportunities: [], checkedAt: "2026-07-17T00:00:00.000Z", warnings: [] }) },
    pipeline: { saveTarget: () => { throw new Error("not called"); }, updateStatus: () => { throw new Error("not called"); }, recordNote: () => { throw new Error("not called"); }, listPipeline: () => [], createShortlist: () => { throw new Error("not called"); } },
    drafts: { createOutreach: () => { throw new Error("not called"); }, createPost: () => { throw new Error("not called"); }, revisePost: () => { throw new Error("not called"); }, getPostHistory: () => [] },
    previews: { create: () => { throw new Error("not called"); } },
    publish: { publish: async () => ({ state: "publish_failed" as const }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: () => ({ connected: false, valid: false, publishingEnabled: false })
  };
}

it("uses complete, safe tool annotations", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await Promise.all([client.close(), server.close()]);

  const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
  for (const name of ["search_yc_companies", "discover_public_people", "find_pmm_opportunities", "rank_networking_targets", "explain_target_match", "preview_post", "list_pipeline", "list_post_history", "get_linkedin_connection_status"]) {
    expect(byName.get(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  }
  for (const name of ["draft_outreach", "draft_linkedin_post", "revise_post", "create_weekly_shortlist", "save_target", "update_outreach_status", "record_note", "create_linkedin_authorization_url"]) {
    expect(byName.get(name)).toMatchObject({ readOnlyHint: false, openWorldHint: false, destructiveHint: false });
  }
  expect(byName.get("publish_linkedin_post")).toMatchObject({ readOnlyHint: false, openWorldHint: true, destructiveHint: false });
  expect([...byName.values()].every((annotation) => annotation !== undefined && annotation !== null)).toBe(true);
});
