import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import JSZip from "jszip";
import type { Response as SuperAgentResponse } from "superagent";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { FOUNDER_EXPORT_CARD_URI } from "../../src/founder-export-card/resource.js";
import { createCareerApplication } from "../../src/index.js";
import type { LinkedInPublishingClient } from "../../src/linkedin/publishing-client.js";
import {
  createTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";
import {
  E2E_AUTH_CONTEXT,
  E2E_SUBJECT,
  FOUNDER_E2E_NOW,
  FOUNDER_E2E_OTHER_SUBJECT,
  FOUNDER_YC_DIRECTORY_FIXTURE,
  mockedFounderCompanyPage
} from "./fixtures.js";

type ConnectedClient = {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  vi.restoreAllMocks();
});

function data(result: unknown): Record<string, unknown> {
  const value = result as { structuredContent?: { data?: Record<string, unknown> } };
  if (value.structuredContent?.data === undefined) throw new Error(JSON.stringify(result));
  return value.structuredContent.data;
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function string(value: unknown): string {
  expect(value).toBeTypeOf("string");
  return value as string;
}

function collectBinary(
  response: SuperAgentResponse,
  callback: (error: Error | null, body?: Buffer) => void
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", callback);
}

async function connect(
  runtime: Awaited<ReturnType<typeof createCareerApplication>>,
  context: Parameters<typeof runtime.createMcpServer>[0]
): Promise<ConnectedClient> {
  const server = runtime.createMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "founder-research-e2e", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  const connected = {
    client,
    server,
    async close() {
      await Promise.all([client.close(), server.close()]);
    }
  };
  cleanups.push(connected.close);
  return connected;
}

function founderConfig() {
  return {
    nodeEnv: "test" as const,
    port: 0,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    migrationDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    baseUrl: "https://career.example",
    authMode: "none" as const,
    allowedSubject: E2E_SUBJECT,
    oidcDiscoveryTimeoutMs: 5_000,
    linkedinPublishEnabled: false,
    linkedinImagePublishEnabled: false,
    linkedinMediaBucket: "linkedin-draft-media" as const,
    linkedinVersion: "202606"
  };
}

async function createStack(): Promise<{
  database: TestCareerDatabase;
  runtime: Awaited<ReturnType<typeof createCareerApplication>>;
  owner: ConnectedClient;
  otherOwner: ConnectedClient;
  unauthenticated: ConnectedClient;
  requestedUrls: string[];
  linkedinWrites: {
    initializeImage: ReturnType<typeof vi.fn>;
    uploadImage: ReturnType<typeof vi.fn>;
    createPost: ReturnType<typeof vi.fn>;
  };
}> {
  const database = await createTestDatabase();
  cleanups.push(async () => await database.close());
  const requestedUrls: string[] = [];
  const linkedinWrites = {
    initializeImage: vi.fn(async () => ({ uploadUrl: "https://unused.invalid", imageUrn: "urn:li:image:unused" })),
    uploadImage: vi.fn(async () => undefined),
    createPost: vi.fn(async () => "urn:li:share:unused")
  };
  const runtime = await createCareerApplication({
    database,
    config: founderConfig(),
    ycSource: { fetch: async () => FOUNDER_YC_DIRECTORY_FIXTURE },
    fetchPage: async (url) => {
      requestedUrls.push(url);
      return mockedFounderCompanyPage(url);
    },
    now: () => new Date(FOUNDER_E2E_NOW),
    linkedinPublishingClient: linkedinWrites as unknown as LinkedInPublishingClient
  });
  return {
    database,
    runtime,
    owner: await connect(runtime, E2E_AUTH_CONTEXT),
    otherOwner: await connect(runtime, {
      subject: FOUNDER_E2E_OTHER_SUBJECT,
      accessToken: "other-private-request-token"
    }),
    unauthenticated: await connect(runtime, undefined),
    requestedUrls,
    linkedinWrites
  };
}

it("completes the two-company founder workflow with an exact private workbook and no LinkedIn action", async () => {
  const {
    database,
    runtime,
    owner,
    otherOwner,
    unauthenticated,
    requestedUrls,
    linkedinWrites
  } = await createStack();

  const unauthenticatedStart = await unauthenticated.client.callTool({
    name: "start_yc_founder_research",
    arguments: { batch: "W26", limit: 2 }
  });
  expect(unauthenticatedStart.structuredContent).toEqual({
    data: { error: { code: "AUTH_REQUIRED" } }
  });

  const started = data(await owner.client.callTool({
    name: "start_yc_founder_research",
    arguments: { batch: "W26", hiring: true, limit: 2 }
  }));
  const run = record(started.run);
  const runId = string(run.id);
  expect(run).toMatchObject({ selectedCount: 2, requestedLimit: 2 });
  expect(records(started.selectedCompanyIds)).toHaveLength(2);

  const processed = data(await owner.client.callTool({
    name: "process_yc_founder_research",
    arguments: { runId, maxCompanies: 2 }
  }));
  const processItems = records(processed.items);
  const publicSearchTasks = records(processed.publicSearchTasks);
  expect(processItems).toHaveLength(2);
  expect(processItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ state: "COMPLETE", founderCount: 1, verifiedProfileCount: 1 }),
    expect.objectContaining({ state: "NEEDS_PUBLIC_SEARCH", founderCount: 0, verifiedProfileCount: 0 })
  ]));
  expect(publicSearchTasks).toEqual([
    expect.objectContaining({
      companyName: "Beacon Search",
      reason: "FOUNDER_NOT_FOUND"
    })
  ]);
  expect(requestedUrls).toEqual(expect.arrayContaining([
    "https://atlas.example/",
    "https://atlas.example/team",
    "https://beacon.example/"
  ]));
  expect(requestedUrls).toHaveLength(3);
  expect(requestedUrls.some((url) => new URL(url).hostname.endsWith("linkedin.com"))).toBe(false);

  const unresolved = publicSearchTasks[0]!;
  const candidateProfileUrl = "https://www.linkedin.com/in/rowan-beacon";
  const candidatesSaved = data(await owner.client.callTool({
    name: "save_founder_profile_candidates",
    arguments: {
      runId,
      candidates: [{
        runItemId: string(unresolved.runItemId),
        founderName: "Rowan Beacon",
        founderRole: "Co-founder",
        candidateProfileUrl,
        searchQuery: "Rowan Beacon Beacon Search co-founder LinkedIn",
        resultUrl: `${candidateProfileUrl}?trk=public_profile`,
        resultTitle: "Rowan Beacon — Co-founder at Beacon Search",
        checkedAt: FOUNDER_E2E_NOW,
        confidence: 0.82,
        linkedInNotFetched: true
      }]
    }
  }));
  const candidateOutcome = records(candidatesSaved.results)[0]!;
  expect(candidateOutcome).toMatchObject({
    state: "SAVED",
    candidate: {
      profileUrl: candidateProfileUrl,
      status: "CANDIDATE",
      sourceKind: "PUBLIC_SEARCH"
    },
    requiresManualReview: true
  });
  expect(requestedUrls).toHaveLength(3);

  const savedCandidate = record(candidateOutcome.candidate);
  const confirmed = data(await owner.client.callTool({
    name: "confirm_founder_profile_candidate",
    arguments: {
      candidateId: string(savedCandidate.id),
      decision: "CONFIRM",
      note: "Manually reviewed by the owner."
    }
  }));
  expect(confirmed).toMatchObject({
    candidate: { status: "CONFIRMED", profileUrl: candidateProfileUrl },
    canonical: { status: "CONFIRMED", profileUrl: candidateProfileUrl },
    requiresManualReview: false
  });

  const runPeople = await database.founderResearchPeople.listForRun(runId, E2E_SUBJECT);
  expect(runPeople).toHaveLength(2);
  const peopleByName = new Map((await Promise.all(runPeople.map(async ({ personId }) => {
    const person = await database.people.get(personId);
    if (person === undefined) throw new Error("Expected founder person");
    return [person.name, person] as const;
  }))));
  expect([...peopleByName.keys()].sort()).toEqual(["Avery Atlas", "Rowan Beacon"]);

  const outreach = data(await owner.client.callTool({
    name: "save_founder_outreach_batch",
    arguments: {
      runId,
      requestId: "founder-e2e-notes-v1",
      entries: [
        {
          personId: peopleByName.get("Avery Atlas")!.id,
          pmmOpportunity: 20,
          referralPotential: 15,
          networkValue: 15,
          total: 50,
          confidence: 0.9,
          reasons: ["Official founder evidence is available."],
          missingEvidence: [],
          evidenceIds: [],
          personalizationClaims: [],
          text: "Hi Avery Atlas — I would value connecting.",
          reviewState: "READY_TO_REVIEW"
        },
        {
          personId: peopleByName.get("Rowan Beacon")!.id,
          pmmOpportunity: 20,
          referralPotential: 15,
          networkValue: 15,
          total: 50,
          confidence: 0.82,
          reasons: ["The owner confirmed the public-search candidate."],
          missingEvidence: [],
          evidenceIds: [],
          personalizationClaims: [],
          text: "Hello Rowan Beacon — I'd love to connect.",
          reviewState: "READY_TO_REVIEW"
        }
      ]
    }
  }));
  expect(outreach).not.toHaveProperty("error");
  const drafts = records(outreach.drafts);
  expect(drafts).toHaveLength(2);
  expect(drafts.map(({ version }) => version)).toEqual([1, 1]);
  expect(outreach.needsVerification).toEqual([]);
  for (const draft of drafts) {
    const savedVersions = await database.outreachDrafts.listForTarget(string(draft.targetId));
    expect(savedVersions).toEqual([
      expect.objectContaining({
        id: string(draft.draftId),
        version: 1,
        purpose: "linkedin_connection_request"
      })
    ]);
  }

  const crossOwnerRead = await otherOwner.client.callTool({
    name: "process_yc_founder_research",
    arguments: { runId, maxCompanies: 1 }
  });
  expect(crossOwnerRead.structuredContent).toEqual({
    data: { error: { code: "NOT_FOUND" } }
  });
  expect(JSON.stringify(crossOwnerRead)).not.toContain("Atlas Verified");
  expect(JSON.stringify(crossOwnerRead)).not.toContain("Avery Atlas");

  const exported = await owner.client.callTool({
    name: "export_founder_research_workbook",
    arguments: { runId }
  });
  expect(exported.isError).not.toBe(true);
  const exportProjection = record(data(exported).export);
  expect(exportProjection).toMatchObject({
    runId,
    rowCount: 2,
    sheetCount: 4
  });
  const exportId = string(exportProjection.id);
  const privateMetadata = exported._meta as Record<string, unknown>;
  const downloadUrl = new URL(string(privateMetadata.downloadUrl));
  expect(downloadUrl.origin).toBe("https://career.example");
  expect(JSON.stringify(exported.structuredContent)).not.toContain("capability");
  expect(JSON.stringify(exported.content)).not.toContain("/download?");

  const card = await owner.client.readResource({ uri: FOUNDER_EXPORT_CARD_URI });
  const cardHtml = (card.contents[0] as { text?: string }).text ?? "";
  expect(cardHtml).toContain("Download Excel");
  expect(cardHtml).toContain('data-application-origin="https://career.example"');
  expect(cardHtml).not.toContain(downloadUrl.searchParams.get("capability"));

  const downloaded = await request(runtime.app)
    .get(`${downloadUrl.pathname}${downloadUrl.search}`)
    .buffer(true)
    .parse(collectBinary);
  expect(downloaded.status).toBe(200);
  expect(Buffer.isBuffer(downloaded.body)).toBe(true);
  const workbookBytes = downloaded.body as Buffer;
  expect(createHash("sha256").update(workbookBytes).digest("hex"))
    .toBe(string(exportProjection.checksumSha256));
  const storedExport = await database.founderResearchExports.getOwned(exportId, E2E_SUBJECT);
  expect(storedExport).toBeDefined();
  expect(workbookBytes).toEqual(Buffer.from(storedExport!.workbookBytes));

  const workbook = await JSZip.loadAsync(workbookBytes, { checkCRC32: true });
  const workbookXml = await workbook.file("xl/workbook.xml")!.async("string");
  const readyXml = await workbook.file("xl/worksheets/sheet1.xml")!.async("string");
  const needsVerificationXml = await workbook.file("xl/worksheets/sheet2.xml")!.async("string");
  const failedXml = await workbook.file("xl/worksheets/sheet3.xml")!.async("string");
  const summaryXml = await workbook.file("xl/worksheets/sheet4.xml")!.async("string");
  expect(workbookXml.match(/<sheet name=/gu)).toHaveLength(4);
  expect(workbookXml).toContain('sheet name="Ready to Review" sheetId="1"');
  expect(workbookXml).toContain('sheet name="Needs Verification" sheetId="2"');
  expect(workbookXml).toContain('sheet name="Not Found - Failed" sheetId="3"');
  expect(workbookXml).toContain('sheet name="Run Summary" sheetId="4"');
  expect(readyXml).toContain("Atlas Verified</t>");
  expect(readyXml).toContain("Beacon Search</t>");
  expect(readyXml).toContain("VERIFIED</t>");
  expect(readyXml).toContain("CONFIRMED</t>");
  expect(needsVerificationXml).not.toContain("Atlas Verified</t>");
  expect(needsVerificationXml).not.toContain("Beacon Search</t>");
  expect(failedXml).not.toContain("Atlas Verified</t>");
  expect(failedXml).not.toContain("Beacon Search</t>");
  expect(summaryXml).toContain("Selected Companies</t>");
  expect(summaryXml).toContain('<c r="B8"><v>2</v></c>');
  expect(summaryXml).toContain("Verified</t>");
  expect(summaryXml).toContain("Confirmed</t>");
  expect(summaryXml).toContain(
    "Connection requests must be reviewed and sent manually on LinkedIn.</t>"
  );

  const otherStarted = data(await otherOwner.client.callTool({
    name: "start_yc_founder_research",
    arguments: { keyword: "Atlas", limit: 1 }
  }));
  const otherRunId = string(record(otherStarted.run).id);
  const otherExported = await otherOwner.client.callTool({
    name: "export_founder_research_workbook",
    arguments: { runId: otherRunId }
  });
  expect(otherExported.isError).not.toBe(true);
  const otherDownloadUrl = new URL(string((otherExported._meta as Record<string, unknown>).downloadUrl));
  const foreignDownload = await request(runtime.app)
    .get(`${otherDownloadUrl.pathname}${otherDownloadUrl.search}`);
  expect(foreignDownload.status).toBe(404);
  expect(foreignDownload.body).toEqual({
    error: "Founder research export is unavailable"
  });
  expect(JSON.stringify(foreignDownload.body)).not.toContain(
    otherDownloadUrl.searchParams.get("capability")
  );

  expect(requestedUrls.some((url) => url.toLowerCase().includes("linkedin"))).toBe(false);
  expect(linkedinWrites.initializeImage).not.toHaveBeenCalled();
  expect(linkedinWrites.uploadImage).not.toHaveBeenCalled();
  expect(linkedinWrites.createPost).not.toHaveBeenCalled();
}, 30_000);
