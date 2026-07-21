import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import nock from "nock";
import { createTestDatabase, type TestCareerDatabase } from "../support/database.js";
import { createCareerApplication } from "../../src/index.js";
import {
  E2E_NOW,
  mockedCompanyPage,
  YC_DIRECTORY_FIXTURE
} from "./fixtures.js";

type TestStack = {
  database: TestCareerDatabase;
  server: Server;
  client: Client;
  close(): Promise<void>;
};

const stacks: TestStack[] = [];

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
  nock.cleanAll();
  nock.enableNetConnect();
});

function data(result: unknown): Record<string, unknown> {
  const value = result as { structuredContent?: { data?: Record<string, unknown> } };
  if (value.structuredContent?.data === undefined) throw new Error(JSON.stringify(result));
  expect(value.structuredContent?.data).toBeDefined();
  return value.structuredContent!.data!;
}

function records(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function object(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

async function startStack(): Promise<TestStack> {
  const database = await createTestDatabase();
  const runtime = (await createCareerApplication({
    database,
    config: {
      nodeEnv: "test",
      port: 0,
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      migrationDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      baseUrl: "http://127.0.0.1:3000",
      authMode: "none",
      oidcDiscoveryTimeoutMs: 5_000,
      linkedinPublishEnabled: false,
      linkedinImagePublishEnabled: false,
      linkedinMediaBucket: "linkedin-draft-media",
      linkedinVersion: "202606",
      tokenEncryptionKey: "a".repeat(64)
    },
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    fetchPage: async (url) => mockedCompanyPage(url),
    resolveAddresses: async () => ["2606:4700:4700::1111"],
    now: () => new Date(E2E_NOW)
  }));
  const server = runtime.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport as never);
  const stack: TestStack = {
    database,
    server,
    client,
    async close() {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      (await database.close());
    }
  };
  stacks.push(stack);
  return stack;
}

it("runs the private career flow and stops at the app-only exact-preview boundary", async () => {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => host.startsWith("127.0.0.1"));
  const linkedinPost = nock("https://api.linkedin.com")
    .post("/rest/posts", {
      author: "urn:li:person:e2e-author",
      commentary: "I am exploring PMM roles.",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    })
    .once()
    .reply(201, undefined, { "x-restli-id": "urn:li:share:12345" });
  const disabled = await startStack();
  const connection = object(data(await disabled.client.callTool({ name: "get_linkedin_connection_status", arguments: {} })).connection);
  expect(connection).toEqual({
    connected: false,
    valid: false,
    publishingEnabled: false,
    imagePublishingEnabled: false
  });
  const companies = records(data(await disabled.client.callTool({ name: "search_yc_companies", arguments: { keyword: "Acme" } })).companies);
  expect(companies).toHaveLength(1);
  const company = companies[0];
  expect(company).toBeDefined();

  const people = records(data(await disabled.client.callTool({ name: "discover_public_people", arguments: { companyId: text(company!.id) } })).people);
  expect(people).toHaveLength(1);
  const person = people[0];
  expect(person).toBeDefined();
  const scoringTarget = {
    companyName: text(company!.name),
    person,
    opportunities: [],
    preferences: {
      roleKeywords: ["product marketing"],
      preferredLocations: ["San Francisco"],
      industries: ["SaaS"]
    },
    weights: { pmmOpportunity: 0.4, referralPotential: 0.3, networkValue: 0.3 },
    evidence: {
      activePmmRole: true,
      companyHiring: true,
      roleSeniority: true,
      sharedDomain: true,
      locationMatch: true,
      recentFundingSignal: false,
      companyCheckedAt: text(company!.checkedAt)
    }
  };
  const ranked = records(data(await disabled.client.callTool({ name: "rank_networking_targets", arguments: { targets: [scoringTarget] } })).targets);
  expect(ranked[0]).toBeDefined();
  expect(ranked[0]!.personId).toBe(text(person!.id));
  const target = object(data(await disabled.client.callTool({ name: "save_target", arguments: { target: scoringTarget } })).target);
  const shortlist = object(data(await disabled.client.callTool({ name: "create_weekly_shortlist", arguments: { name: "This week", targetIds: [text(target.id)] } })).shortlist);
  expect(records(shortlist.entries)).toHaveLength(1);
  const post = object(data(await disabled.client.callTool({ name: "draft_linkedin_post", arguments: { text: "I am exploring PMM roles.", visibility: "PUBLIC" } })).post);
  const exactPreview = await disabled.client.callTool({
    name: "create_exact_linkedin_preview",
    arguments: { postId: text(post.id), version: post.version }
  });
  expect(exactPreview.isError).toBe(true);
  expect(exactPreview.structuredContent).toEqual({
    data: { error: { code: "AUTH_REQUIRED" } }
  });

  for (const call of [
    {
      name: "attach_linkedin_post_images",
      arguments: {
        postId: text(post.id),
        expectedVersion: post.version,
        images: [{ download_url: "https://files.example/image.png", file_id: "file-1" }],
        altTexts: ["A private PMM image"]
      }
    },
    {
      name: "open_linkedin_review_card",
      arguments: { postId: text(post.id), version: post.version }
    }
  ]) {
    const result = await disabled.client.callTool(call);
    expect(result.isError, call.name).toBe(true);
    expect(result.structuredContent, call.name).toEqual({
      data: { error: { code: "AUTH_REQUIRED" } }
    });
  }

  const legacyPreview = await disabled.client.callTool({
    name: "preview_post",
    arguments: { postId: text(post.id), version: post.version }
  });
  expect(legacyPreview.isError).toBe(true);
  expect(JSON.stringify(legacyPreview)).toContain("Tool preview_post not found");
  expect(JSON.stringify(exactPreview)).not.toContain("previewToken");
  expect(linkedinPost.isDone()).toBe(false);
}, 15_000);
