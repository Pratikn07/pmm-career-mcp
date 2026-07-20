import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createCareerMcpServer, type CareerMcpDependencies } from "../../src/mcp/server.js";

function dependencies(): CareerMcpDependencies {
  return {
    ycProvider: { searchYcCompanies: async () => [] },
    peopleDiscovery: { discoverPublicPeople: async () => ({ people: [], evidence: [], checkedAt: "2026-07-17T00:00:00.000Z", coverage: "authoritative-pages-only", warnings: [] }) },
    jobDiscovery: { findPmmOpportunities: async () => ({ opportunities: [], checkedAt: "2026-07-17T00:00:00.000Z", warnings: [] }) },
    pipeline: { saveTarget: async () => { throw new Error("not called"); }, updateStatus: async () => { throw new Error("not called"); }, recordNote: async () => { throw new Error("not called"); }, listPipeline: async () => [], createShortlist: async () => { throw new Error("not called"); } },
    drafts: { createOutreach: async () => { throw new Error("not called"); }, createPost: async () => { throw new Error("not called"); }, revisePost: async () => { throw new Error("not called"); }, getPostHistory: async () => [] },
    previews: { create: () => { throw new Error("not called"); } },
    publish: { publish: async () => ({ state: "publish_failed" as const }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: async () => ({ connected: false, valid: false, publishingEnabled: false, imagePublishingEnabled: false })
  };
}

it("uses complete, safe tool annotations", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await Promise.all([client.close(), server.close()]);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const annotationsFor = (name: string) => byName.get(name)?.annotations;
  for (const name of ["search_yc_companies", "discover_public_people", "find_pmm_opportunities", "rank_networking_targets", "explain_target_match", "list_pipeline", "list_post_history", "get_linkedin_connection_status", "open_linkedin_review_card"]) {
    expect(annotationsFor(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  }
  for (const name of ["draft_outreach", "draft_linkedin_post", "revise_post", "set_linkedin_post_images", "create_weekly_shortlist", "save_target", "update_outreach_status", "record_note", "create_linkedin_authorization_url"]) {
    expect(annotationsFor(name)).toMatchObject({ readOnlyHint: false, openWorldHint: false, destructiveHint: false });
  }
  expect(annotationsFor("preview_post")).toEqual({
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false
  });
  expect(annotationsFor("attach_linkedin_post_images")).toEqual({
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false
  });
  expect(annotationsFor("publish_linkedin_post")).toMatchObject({ readOnlyHint: false, openWorldHint: true, destructiveHint: false });
  expect([...byName.values()].every((tool) => tool.annotations !== undefined && tool.annotations !== null)).toBe(true);
  for (const tool of byName.values()) {
    expect(tool._meta).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: ["openid", "email"] }]
    });
  }

  expect(byName.get("attach_linkedin_post_images")?._meta).toMatchObject({
    "openai/fileParams": ["images"]
  });
  expect(byName.get("open_linkedin_review_card")?._meta).toMatchObject({
    "openai/outputTemplate": "ui://pmm-career-mcp/linkedin-review-card.html",
    "openai/widgetAccessible": true
  });
  expect(byName.get("preview_post")?._meta).toMatchObject({
    ui: { visibility: ["app"] }
  });
  expect(byName.get("publish_linkedin_post")?._meta).toMatchObject({
    ui: { visibility: ["app"] }
  });

  const modelVisibleNames = tools
    .filter((tool) => !((tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility?.includes("app") ?? false))
    .map((tool) => tool.name);
  expect(modelVisibleNames).not.toContain("preview_post");
  expect(modelVisibleNames).not.toContain("publish_linkedin_post");
});
