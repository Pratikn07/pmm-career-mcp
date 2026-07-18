import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import nock from "nock";
import { createTestDatabase, type TestCareerDatabase } from "../support/database.js";
import { createCareerApplication } from "../../src/index.js";
import { encryptJson } from "../../src/security/crypto.js";
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

function number(value: unknown): number {
  expect(typeof value).toBe("number");
  return value as number;
}

function publishInput(preview: Record<string, unknown>) {
  return {
    postId: text(preview.postId),
    versionId: text(preview.versionId),
    version: number(preview.version),
    checksum: text(preview.checksum),
    visibility: text(preview.visibility),
    previewToken: text(preview.previewToken)
  };
}

async function startStack(publishEnabled: boolean): Promise<TestStack> {
  const database = await createTestDatabase();
  if (publishEnabled) {
    (await database.oauthTokens.upsert({
      provider: "linkedin",
      ciphertext: JSON.stringify(encryptJson({
        accessToken: "e2e-access-token",
        authorUrn: "urn:li:person:e2e-author"
      }, "a".repeat(64))),
      expiresAt: "2030-07-17T13:00:00.000Z"
    }));
  }
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
      linkedinPublishEnabled: publishEnabled,
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

it("runs the private career flow and only publishes one exact enabled preview", async () => {
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
  const disabled = await startStack(false);
  const connection = object(data(await disabled.client.callTool({ name: "get_linkedin_connection_status", arguments: {} })).connection);
  expect(connection).toEqual({ connected: false, valid: false, publishingEnabled: false });
  const companies = records(data(await disabled.client.callTool({ name: "search_yc_companies", arguments: { keyword: "Acme" } })).companies);
  expect(companies).toHaveLength(1);
  const company = companies[0];
  expect(company).toBeDefined();

  const people = records(data(await disabled.client.callTool({ name: "discover_public_people", arguments: { companyId: text(company!.id) } })).people);
  expect(people).toHaveLength(1);
  const person = people[0];
  expect(person).toBeDefined();
  const score = {
    personId: text(person!.id),
    companyId: text(company!.id),
    companyName: text(company!.name),
    name: text(person!.name),
    pmmOpportunity: 40,
    referralPotential: 30,
    networkValue: 30,
    total: 100,
    confidence: 0.9,
    reasons: ["PMM role and marketing leader are public"],
    missingEvidence: []
  };
  const ranked = records(data(await disabled.client.callTool({ name: "rank_networking_targets", arguments: { scores: [score] } })).targets);
  expect(ranked[0]).toBeDefined();
  expect(ranked[0]!.personId).toBe(text(person!.id));
  const target = object(data(await disabled.client.callTool({ name: "save_target", arguments: { score } })).target);
  const shortlist = object(data(await disabled.client.callTool({ name: "create_weekly_shortlist", arguments: { name: "This week", targetIds: [text(target.id)] } })).shortlist);
  expect(records(shortlist.entries)).toHaveLength(1);
  const post = object(data(await disabled.client.callTool({ name: "draft_linkedin_post", arguments: { text: "I am exploring PMM roles.", visibility: "PUBLIC" } })).post);
  const preview = object(data(await disabled.client.callTool({ name: "preview_post", arguments: { postId: text(post.id), version: number(post.version) } })).preview);
  const disabledPublish = await disabled.client.callTool({ name: "publish_linkedin_post", arguments: publishInput(preview) });
  expect(disabledPublish.isError).toBe(true);
  expect(JSON.stringify(disabledPublish)).toContain("PUBLISH_DISABLED");
  expect(linkedinPost.isDone()).toBe(false);

  const enabled = await startStack(true);
  // A separately configured runtime proves the only setting that opens the external-write path.
  const enabledPost = object(data(await enabled.client.callTool({ name: "draft_linkedin_post", arguments: { text: "I am exploring PMM roles.", visibility: "PUBLIC" } })).post);
  const enabledPreview = object(data(await enabled.client.callTool({ name: "preview_post", arguments: { postId: text(enabledPost.id), version: number(enabledPost.version) } })).preview);
  const enabledPublishInput = publishInput(enabledPreview);
  const firstPublish = data(await enabled.client.callTool({ name: "publish_linkedin_post", arguments: enabledPublishInput })).result;
  expect(firstPublish).toEqual({ state: "published", postUrn: "urn:li:share:12345" });
  const replay = await enabled.client.callTool({ name: "publish_linkedin_post", arguments: enabledPublishInput });
  expect(replay.isError).toBe(true);
  expect(JSON.stringify(replay)).toContain("PREVIEW_CONSUMED");
  expect(linkedinPost.isDone()).toBe(true);
}, 15_000);
