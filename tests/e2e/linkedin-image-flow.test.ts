import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import type { RequestAuthContext } from "../../src/auth/request-context.js";
import type { AppConfig } from "../../src/config.js";
import { createCareerApplication, type CareerApplication } from "../../src/index.js";
import type { ImageInspection } from "../../src/media/image-inspection.js";
import type { DraftMediaStorage } from "../../src/media/storage.js";
import { encryptJson } from "../../src/security/crypto.js";
import { createTestDatabase, type TestCareerDatabase } from "../support/database.js";
import { E2E_NOW, YC_DIRECTORY_FIXTURE } from "./fixtures.js";

const SUBJECT = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN_KEY = "a".repeat(64);
const IMAGE_BYTES = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4);
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");
const AUTH_CONTEXT: RequestAuthContext = Object.freeze({
  subject: SUBJECT,
  accessToken: "private-request-token"
});

type TestRuntime = Readonly<{
  database: TestCareerDatabase;
  application: CareerApplication;
}>;

type ConnectedClient = Readonly<{
  client: Client;
  close(): Promise<void>;
}>;

const runtimes: TestRuntime[] = [];
const clients: ConnectedClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(({ close }) => close()));
  await Promise.all(runtimes.splice(0).map(({ database }) => database.close()));
  vi.restoreAllMocks();
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
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
    allowedSubject: SUBJECT,
    linkedinPublishEnabled: false,
    linkedinImagePublishEnabled: false,
    linkedinMediaBucket: "linkedin-draft-media",
    linkedinVersion: "202606",
    tokenEncryptionKey: TOKEN_KEY,
    ...overrides
  };
}

function localNoAuthConfig(): AppConfig {
  const {
    supabaseUrl: _supabaseUrl,
    supabasePublishableKey: _supabasePublishableKey,
    oidcIssuer: _oidcIssuer,
    oidcAudience: _oidcAudience,
    allowedSubject: _allowedSubject,
    tokenEncryptionKey: _tokenEncryptionKey,
    ...local
  } = config();
  return { ...local, authMode: "none" };
}

function structuredData(result: unknown): Record<string, unknown> {
  const value = result as { structuredContent?: { data?: Record<string, unknown> } };
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

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage: DraftMediaStorage = {
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
  return { storage, objects };
}

function imageInspection(): ImageInspection {
  return {
    mimeType: "image/png",
    width: 4,
    height: 3,
    frameCount: 1,
    byteSize: IMAGE_BYTES.byteLength,
    sha256: IMAGE_SHA256
  };
}

async function createRuntime(input: {
  storage: DraftMediaStorage;
  linkedinPublishEnabled?: boolean;
  linkedinImagePublishEnabled?: boolean;
}) {
  const database = await createTestDatabase();
  const linkedin = {
    initializeImage: vi.fn(async () => ({
      outcome: "ready" as const,
      imageUrn: "urn:li:image:test-image",
      uploadUrl: "https://upload.linkedin.com/test-image"
    })),
    uploadImage: vi.fn(async () => ({ outcome: "uploaded" as const })),
    createPost: vi.fn(async () => ({
      outcome: "published" as const,
      postUrn: "urn:li:share:12345"
    }))
  };
  const downloadFile = vi.fn(async () => new Uint8Array(IMAGE_BYTES));
  const inspectImage = vi.fn(async () => imageInspection());
  const mediaStorageFactory = vi.fn(() => input.storage);
  const application = await createCareerApplication({
    database,
    config: config({
      linkedinPublishEnabled: input.linkedinPublishEnabled ?? false,
      linkedinImagePublishEnabled: input.linkedinImagePublishEnabled ?? false
    }),
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    now: () => new Date(E2E_NOW),
    linkedinPublishingClient: linkedin,
    mediaStorageFactory,
    mediaDownloadFile: downloadFile,
    mediaInspectImage: inspectImage
  });
  runtimes.push({ application, database });
  return { application, database, linkedin, mediaStorageFactory, downloadFile, inspectImage };
}

async function connect(
  application: CareerApplication,
  context: RequestAuthContext | undefined
): Promise<ConnectedClient> {
  const server = application.createMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "linkedin-image-e2e", version: "1.0.0" });
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

async function draftAndAttach(client: Client) {
  const companies = structuredData(await client.callTool({
    name: "search_yc_companies",
    arguments: { keyword: "Acme" }
  })).companies as unknown[];
  expect(companies).toHaveLength(1);

  const draft = record(structuredData(await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "A private PMM morning draft.", visibility: "CONNECTIONS" }
  })).post);
  const attached = record(structuredData(await client.callTool({
    name: "attach_linkedin_post_images",
    arguments: {
      postId: text(draft.id),
      expectedVersion: integer(draft.version),
      images: [{
        download_url: "https://files.openai.example/generated.png",
        file_id: "file-generated-1",
        mime_type: "image/png",
        file_name: "generated.png"
      }],
      altTexts: ["A product marketing launch dashboard"]
    }
  })).post);
  return attached;
}

it("runs the morning image flow through the launcher and stops before exact preview or LinkedIn", async () => {
  const { storage } = memoryStorage();
  const { application, database, linkedin, mediaStorageFactory, downloadFile, inspectImage } = await createRuntime({ storage });
  const { client } = await connect(application, AUTH_CONTEXT);

  const attached = await draftAndAttach(client);
  const opened = await client.callTool({
    name: "open_linkedin_review_card",
    arguments: { postId: text(attached.id), version: integer(attached.version) }
  });

  expect(opened.isError).not.toBe(true);
  expect(record(structuredData(opened).post)).toMatchObject({
    id: attached.id,
    version: attached.version,
    media: [{ position: 0, altText: "A product marketing launch dashboard" }]
  });
  expect(await database.previews.listForPostDraft(text(attached.versionId))).toEqual([]);
  expect(await database.publishAttempts.listForPostDraft(text(attached.versionId))).toEqual([]);
  expect(mediaStorageFactory).toHaveBeenCalledWith(expect.any(Object), AUTH_CONTEXT);
  expect(downloadFile).toHaveBeenCalledOnce();
  expect(inspectImage).toHaveBeenCalledOnce();
  expect(linkedin.initializeImage).not.toHaveBeenCalled();
  expect(linkedin.uploadImage).not.toHaveBeenCalled();
  expect(linkedin.createPost).not.toHaveBeenCalled();
});

it("creates an exact preview only interactively and both disabled switches stop before LinkedIn", async () => {
  const { storage } = memoryStorage();
  const first = await createRuntime({ storage });
  const firstConnection = await connect(first.application, AUTH_CONTEXT);
  const attached = await draftAndAttach(firstConnection.client);
  const exact = await firstConnection.client.callTool({
    name: "create_exact_linkedin_preview",
    arguments: { postId: text(attached.id), version: integer(attached.version) }
  });
  expect(exact.isError).not.toBe(true);
  const capability = text((exact._meta as Record<string, unknown>).approvalCapability);
  expect(await first.database.previews.listForPostDraft(text(attached.versionId))).toHaveLength(1);

  const masterDisabled = await firstConnection.client.callTool({
    name: "publish_exact_linkedin_post",
    arguments: { approvalCapability: capability }
  });
  expect(masterDisabled.isError).toBe(true);
  expect(masterDisabled.structuredContent).toEqual({
    data: { error: { code: "PUBLISH_DISABLED" } }
  });

  await first.database.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: JSON.stringify(encryptJson({
      accessToken: "test-linkedin-access-token",
      authorUrn: "urn:li:person:e2e-author"
    }, TOKEN_KEY)),
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const imageDisabled = await createCareerApplication({
    database: first.database,
    config: config({ linkedinPublishEnabled: true, linkedinImagePublishEnabled: false }),
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    now: () => new Date(E2E_NOW),
    linkedinPublishingClient: first.linkedin,
    mediaStorageFactory: () => storage,
    mediaDownloadFile: async () => new Uint8Array(IMAGE_BYTES),
    mediaInspectImage: async () => imageInspection()
  });
  const secondConnection = await connect(imageDisabled, AUTH_CONTEXT);
  const imageSwitchResult = await secondConnection.client.callTool({
    name: "publish_exact_linkedin_post",
    arguments: { approvalCapability: capability }
  });
  expect(imageSwitchResult.isError).toBe(true);
  expect(imageSwitchResult.structuredContent).toEqual({
    data: { error: { code: "PUBLISH_DISABLED" } }
  });

  expect((await first.database.previews.listForPostDraft(text(attached.versionId)))[0]?.consumedAt).toBeNull();
  expect(await first.database.publishAttempts.listForPostDraft(text(attached.versionId))).toEqual([]);
  expect(first.linkedin.initializeImage).not.toHaveBeenCalled();
  expect(first.linkedin.uploadImage).not.toHaveBeenCalled();
  expect(first.linkedin.createPost).not.toHaveBeenCalled();
});

it("keeps local no-auth text flows working while private-media and unavailable LinkedIn paths fail closed", async () => {
  const database = await createTestDatabase();
  const mediaStorageFactory = vi.fn(() => memoryStorage().storage);
  const application = await createCareerApplication({
    database,
    config: localNoAuthConfig(),
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    mediaStorageFactory
  });
  runtimes.push({ application, database });
  const { client } = await connect(application, undefined);

  const research = await client.callTool({ name: "search_yc_companies", arguments: { keyword: "Acme" } });
  const draft = record(structuredData(await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "Local private draft", visibility: "CONNECTIONS" }
  })).post);
  expect(research.isError).not.toBe(true);
  for (const call of [
    {
      name: "attach_linkedin_post_images",
      arguments: {
        postId: text(draft.id),
        expectedVersion: integer(draft.version),
        images: [{ download_url: "https://files.example/image.png", file_id: "file-1" }],
        altTexts: ["Private image"]
      }
    },
    {
      name: "open_linkedin_review_card",
      arguments: { postId: text(draft.id), version: integer(draft.version) }
    },
    {
      name: "create_exact_linkedin_preview",
      arguments: { postId: text(draft.id), version: integer(draft.version) }
    }
  ]) {
    const result = await client.callTool(call);
    expect(result.isError, call.name).toBe(true);
    expect(result.structuredContent, call.name).toEqual({
      data: { error: { code: "AUTH_REQUIRED" } }
    });
  }
  const oauth = await client.callTool({
    name: "create_linkedin_authorization_url",
    arguments: {}
  });
  expect(oauth.isError).toBe(true);
  expect(oauth.structuredContent).toEqual({
    data: { error: { code: "OAUTH_PROVIDER_ERROR" } }
  });
  expect(mediaStorageFactory).not.toHaveBeenCalled();
});

it("returns generic OAuth errors before claims or network calls when LinkedIn adapters are unavailable", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be called"));
  const database = await createTestDatabase();
  const { storage } = memoryStorage();
  const base = config({ linkedinPublishEnabled: true, linkedinImagePublishEnabled: true });
  const { tokenEncryptionKey: _tokenEncryptionKey, ...withoutTokenKey } = base;
  const application = await createCareerApplication({
    database,
    config: withoutTokenKey,
    ycSource: { fetch: async () => YC_DIRECTORY_FIXTURE },
    now: () => new Date(E2E_NOW),
    mediaStorageFactory: () => storage,
    mediaDownloadFile: async () => new Uint8Array(IMAGE_BYTES),
    mediaInspectImage: async () => imageInspection()
  });
  runtimes.push({ application, database });
  const { client } = await connect(application, AUTH_CONTEXT);
  const attached = await draftAndAttach(client);
  const exact = await client.callTool({
    name: "create_exact_linkedin_preview",
    arguments: { postId: text(attached.id), version: integer(attached.version) }
  });
  const capability = text((exact._meta as Record<string, unknown>).approvalCapability);

  for (const call of [
    { name: "create_linkedin_authorization_url", arguments: {} },
    { name: "publish_exact_linkedin_post", arguments: { approvalCapability: capability } }
  ]) {
    const result = await client.callTool(call);
    expect(result.isError, call.name).toBe(true);
    expect(result.structuredContent, call.name).toEqual({
      data: { error: { code: "OAUTH_PROVIDER_ERROR" } }
    });
  }
  expect((await database.previews.listForPostDraft(text(attached.versionId)))[0]?.consumedAt).toBeNull();
  expect(await database.publishAttempts.listForPostDraft(text(attached.versionId))).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
