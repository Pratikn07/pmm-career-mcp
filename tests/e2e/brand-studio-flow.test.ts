import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { createCareerApplication, type CareerApplication } from "../../src/index.js";
import type { DraftMediaStorage } from "../../src/media/storage.js";
import {
  createReviewCardController,
  type ReviewCardView
} from "../../src/review-card/controller.js";
import {
  createTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";
import {
  E2E_AUTH_CONTEXT,
  E2E_NOW,
  E2E_SUBJECT,
  YC_DIRECTORY_FIXTURE
} from "./fixtures.js";

type ConnectedClient = Readonly<{
  client: Client;
  close(): Promise<void>;
}>;

const runtimes: TestCareerDatabase[] = [];
const clients: ConnectedClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(({ close }) => close()));
  await Promise.all(runtimes.splice(0).map((database) => database.close()));
  vi.restoreAllMocks();
});

function config(): AppConfig {
  return {
    nodeEnv: "test",
    port: 0,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    migrationDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    baseUrl: "https://career.example.test",
    supabaseUrl: "https://project-ref.supabase.co",
    supabasePublishableKey: `sb_publishable_${"a".repeat(31)}`,
    authMode: "oauth",
    oidcDiscoveryTimeoutMs: 5_000,
    oidcIssuer: "https://project-ref.supabase.co/auth/v1",
    oidcAudience: "https://career.example.test",
    allowedSubject: E2E_SUBJECT,
    linkedinPublishEnabled: true,
    linkedinImagePublishEnabled: true,
    linkedinMediaBucket: "linkedin-draft-media",
    linkedinVersion: "202606",
    tokenEncryptionKey: "a".repeat(64)
  };
}

function structuredData(result: unknown): Record<string, unknown> {
  const value = result as {
    structuredContent?: { data?: Record<string, unknown> };
  };
  expect(value.structuredContent?.data).toBeDefined();
  return value.structuredContent!.data!;
}

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function integer(value: unknown): number {
  expect(Number.isSafeInteger(value)).toBe(true);
  return value as number;
}

function memoryStorage(): DraftMediaStorage {
  const objects = new Map<string, Uint8Array>();
  return {
    upload: vi.fn(async (path, bytes) => {
      objects.set(path, new Uint8Array(bytes));
    }),
    download: vi.fn(async (path) => {
      const bytes = objects.get(path);
      if (bytes === undefined) throw new Error("missing private object");
      return new Uint8Array(bytes);
    }),
    createSignedUrl: vi.fn(async (path) => (
      `https://project-ref.supabase.co/storage/v1/object/sign/linkedin-draft-media/${encodeURIComponent(path)}`
    )),
    remove: vi.fn(async (paths) => {
      for (const path of paths) objects.delete(path);
    })
  };
}

async function connect(application: CareerApplication): Promise<ConnectedClient> {
  const server = application.createMcpServer(E2E_AUTH_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "brand-studio-e2e", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const connected = {
    client,
    async close() {
      await Promise.all([client.close(), server.close()]);
    }
  };
  clients.push(connected);
  return connected;
}

it("keeps the complete scheduled statement-cover flow private until the widget locks the exact preview", async () => {
  const database = await createTestDatabase();
  runtimes.push(database);
  const storage = memoryStorage();
  const linkedin = {
    initializeImage: vi.fn(),
    uploadImage: vi.fn(),
    createPost: vi.fn()
  };
  const application = await createCareerApplication({
    database,
    config: config(),
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    now: () => new Date(E2E_NOW),
    mediaStorageFactory: vi.fn(() => storage),
    linkedinPublishingClient: linkedin
  });
  const { client } = await connect(application);

  const tools = (await client.listTools()).tools;
  const modelVisibleNames = tools
    .filter((tool) => !(
      (tool._meta?.ui as { visibility?: string[] } | undefined)
        ?.visibility?.includes("app") ?? false
    ))
    .map(({ name }) => name);
  expect(modelVisibleNames).toEqual(expect.arrayContaining([
    "get_pmm_brand_profile",
    "create_branded_visual_brief",
    "render_branded_linkedin_cover",
    "open_linkedin_review_card"
  ]));
  expect(modelVisibleNames).not.toContain("create_exact_linkedin_preview");
  expect(modelVisibleNames).not.toContain("publish_exact_linkedin_post");

  const drafted = record(structuredData(await client.callTool({
    name: "draft_linkedin_post",
    arguments: {
      text: "Strong positioning helps teams understand why a product belongs in their work.",
      visibility: "PUBLIC"
    }
  })).post);
  const profile = record(structuredData(await client.callTool({
    name: "get_pmm_brand_profile",
    arguments: {}
  })).profile);
  expect(profile).toMatchObject({
    publicName: "BHAGYASHREE NANDOSKAR",
    roleLine: "PRODUCT MARKETING",
    seriesName: "EDITORIAL INTELLIGENCE",
    monogram: "BN"
  });

  const briefResult = structuredData(await client.callTool({
    name: "create_branded_visual_brief",
    arguments: {
      postId: text(drafted.id),
      expectedVersion: integer(drafted.version),
      coverHook: "Clarity creates momentum.",
      conceptSummary: "Restrained editorial geometry about positioning and momentum.",
      visualMode: "EDITORIAL_STATEMENT",
      topicLabel: "Positioning"
    }
  }));
  expect(briefResult).not.toHaveProperty("error");
  const brief = record(briefResult.brief);
  expect(briefResult.requiresSourceImage).toBe(false);

  const renderedResult = structuredData(await client.callTool({
    name: "render_branded_linkedin_cover",
    arguments: {
      briefId: text(brief.id),
      postId: text(drafted.id),
      expectedVersion: integer(drafted.version),
      altText: text(briefResult.proposedAltText)
    }
  }));
  expect(renderedResult).not.toHaveProperty("error");
  const renderedPost = record(renderedResult.post);
  const provenance = record(renderedResult.provenance);
  expect(record((renderedPost.media as unknown[])[0])).toMatchObject({
    position: 0,
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    originalFilename: "brand-cover.png"
  });
  expect(renderedPost.media).toHaveLength(1);

  const opened = await client.callTool({
    name: "open_linkedin_review_card",
    arguments: {
      postId: text(renderedPost.id),
      version: integer(renderedPost.version)
    }
  });
  expect(opened.isError).not.toBe(true);
  expect(structuredData(opened).brand).toMatchObject({
    renderChecksum: provenance.renderChecksum,
    validationPassed: true
  });

  expect(await database.previews.listForPostDraft(text(renderedPost.versionId))).toEqual([]);
  expect(await database.publishAttempts.listForPostDraft(text(renderedPost.versionId))).toEqual([]);
  expect(linkedin.initializeImage).not.toHaveBeenCalled();
  expect(linkedin.uploadImage).not.toHaveBeenCalled();
  expect(linkedin.createPost).not.toHaveBeenCalled();

  const views: ReviewCardView[] = [];
  const errors: string[] = [];
  let exactPreviewResult: unknown;
  const controller = createReviewCardController({
    storageOrigin: "https://project-ref.supabase.co",
    globals: {
      snapshot: () => ({
        toolOutput: opened.structuredContent,
        toolResponseMetadata: {
          status: "complete",
          call_tool_result: opened.structuredContent,
          mcp_tool_result: {
            content: opened.content,
            structuredContent: opened.structuredContent,
            _meta: opened._meta
          }
        }
      }),
      subscribe: () => () => undefined
    },
    callTool: vi.fn(async (name, arguments_) => {
      expect(name).toBe("create_exact_linkedin_preview");
      exactPreviewResult = await client.callTool({ name, arguments: arguments_ });
      return exactPreviewResult;
    }),
    ui: {
      render: (view) => views.push(view),
      showError: (message) => errors.push(message),
      setBusy: vi.fn(),
      setPublishingEnabled: vi.fn(),
      showTerminal: vi.fn(),
      confirm: vi.fn(async () => false)
    },
    now: () => new Date(E2E_NOW)
  });
  await controller.start();
  await controller.createPreview();

  expect(errors).toEqual([]);
  expect(views.at(-1)).toMatchObject({
    postId: renderedPost.id,
    version: renderedPost.version,
    previewExpiresAt: "2026-07-17T12:15:00.000Z",
    brand: {
      renderChecksum: provenance.renderChecksum,
      validationPassed: true
    }
  });
  const exactPreview = record(structuredData(exactPreviewResult).preview);
  expect(record((exactPreview.media as unknown[])[0]).sha256)
    .toBe(provenance.renderChecksum);
  expect(await database.previews.listForPostDraft(text(renderedPost.versionId))).toHaveLength(1);
  expect(await database.publishAttempts.listForPostDraft(text(renderedPost.versionId))).toEqual([]);
  expect(linkedin.initializeImage).not.toHaveBeenCalled();
  expect(linkedin.uploadImage).not.toHaveBeenCalled();
  expect(linkedin.createPost).not.toHaveBeenCalled();
}, 15_000);
