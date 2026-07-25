import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const START = "2026-07-25T18:00:00.000Z";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const database: TestCareerDatabase = await createTestDatabase();

afterEach(async () => await database.resetForTests());
afterAll(async () => await database.close());

async function seedReadyRun(): Promise<{ runId: string; targetId: string }> {
  const company = await database.companies.upsert({
    ycId: "export-acme",
    name: "Export Acme",
    batch: "S24",
    status: "Active",
    websiteUrl: "https://export-acme.example/",
    isHiring: true,
    checkedAt: START
  });
  const created = await database.founderResearchRuns.create({
    ownerSubject: OWNER,
    queryJson: { batch: "S24", hiring: true },
    requestedLimit: 1,
    companyIds: [company.id]
  });
  const item = created.items[0]!;
  const person = await database.people.upsert({
    companyId: company.id,
    name: "Ada Export",
    role: "Founder & CEO",
    checkedAt: START
  });
  const runPerson = await database.founderResearchPeople.saveOfficial({
    runItemId: item.id,
    ownerSubject: OWNER,
    personId: person.id,
    founderRoleMatch: "Founder & CEO",
    confidence: 0.95
  });
  const profile = await database.founderProfileCandidates.recordOfficial({
    runPersonId: runPerson.id,
    ownerSubject: OWNER,
    profileUrl: "https://www.linkedin.com/in/ada-export",
    sourceKind: "OFFICIAL_COMPANY",
    evidenceUrl: "https://export-acme.example/team",
    evidenceTitle: "Leadership",
    evidenceSnippet: "Ada Export is Founder & CEO.",
    evidenceMetadataJson: { source: "test" },
    checkedAt: START,
    confidence: 0.95
  });
  expect(profile.status).toBe("VERIFIED");
  const target = await database.targets.upsert({
    personId: person.id,
    pmmOpportunity: 90,
    referralPotential: 70,
    networkValue: 80,
    totalScore: 80,
    confidence: 0.9,
    rationale: "Saved evidence supports the review."
  });
  await database.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "linkedin_connection_request",
    text: "Hi Ada Export — I would value connecting.",
    evidenceIds: []
  });
  return { runId: created.run.id, targetId: target.id };
}

async function exportService(now: () => Date, subject = OWNER) {
  const module = await import("../../src/founder-research/export-service.js");
  return module.createFounderResearchExportService(database, { subject, now });
}

async function createPrivateExport(
  runId: string,
  idempotencyKey: string,
  now: () => Date
) {
  let privateMetadata: { capability: string; expiresAt: string } | undefined;
  const exportMetadata = await (await exportService(now)).createExport(
    { runId, idempotencyKey },
    (metadata) => { privateMetadata = metadata; }
  );
  if (privateMetadata === undefined) throw new Error("Private export metadata was not issued");
  return { exportMetadata, privateMetadata };
}

describe("founder research export service", () => {
  it("persists an owner-scoped exact workbook and only exposes the raw capability privately", async () => {
    const { runId } = await seedReadyRun();
    const result = await createPrivateExport(
      runId,
      "export-2026-07-25",
      () => new Date(START)
    );

    expect(result.exportMetadata.mimeType).toBe(XLSX_MIME);
    expect(result.exportMetadata.rowCount).toBe(1);
    expect(result.exportMetadata.sheetCount).toBe(4);
    expect(result.exportMetadata.fileName).toMatch(/\.xlsx$/u);
    expect(result.exportMetadata.expiresAt).toBe("2026-08-01T18:00:00.000Z");
    expect(Buffer.from(result.privateMetadata.capability, "base64url")).toHaveLength(32);
    expect(JSON.stringify(result.exportMetadata).includes(result.privateMetadata.capability)).toBe(false);

    const stored = (await database.founderResearchExports.getOwned(
      result.exportMetadata.id,
      OWNER
    ))!;
    const bytes = Buffer.from(stored.workbookBytes);
    expect(bytes.byteLength).toBe(result.exportMetadata.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.exportMetadata.checksumSha256);
    expect(stored.checksumSha256).toBe(result.exportMetadata.checksumSha256);
    expect(stored.rowCount).toBe(1);
    expect(stored.sheetCount).toBe(4);

    const capabilities = await queryTestDatabase<{ token_hash_sha256: string }>(database, `
      select token_hash_sha256
      from career_mcp.founder_export_download_capabilities
      where export_id = '${result.exportMetadata.id}'
    `);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.token_hash_sha256).toBe(
      createHash("sha256").update(result.privateMetadata.capability).digest("hex")
    );
    expect(JSON.stringify(capabilities).includes(result.privateMetadata.capability)).toBe(false);
    await expect((await exportService(() => new Date(START), OTHER_OWNER)).createExport(
      { runId, idempotencyKey: "foreign-owner" },
      () => undefined
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reuses an unexpired export for the same key and creates a new export when the saved snapshot changes", async () => {
    const { runId, targetId } = await seedReadyRun();
    const first = await createPrivateExport(runId, "retry-key", () => new Date(START));
    const retry = await createPrivateExport(runId, "retry-key", () => new Date(START));
    expect(retry.exportMetadata.id).toBe(first.exportMetadata.id);

    await database.outreachDrafts.createVersion({
      targetId,
      purpose: "linkedin_connection_request",
      text: "Hello Ada Export — I would value connecting.",
      evidenceIds: []
    });
    const changed = await createPrivateExport(runId, "retry-key", () => new Date(START));
    expect(changed.exportMetadata.id).not.toBe(first.exportMetadata.id);
    expect(changed.exportMetadata.checksumSha256).not.toBe(first.exportMetadata.checksumSha256);
  });

  it("cleans up expired owned artifacts", async () => {
    const { runId } = await seedReadyRun();
    let now = new Date(START);
    const service = await exportService(() => now);
    let createdId: string | undefined;
    const created = await service.createExport(
      { runId, idempotencyKey: "cleanup" },
      () => undefined
    );
    createdId = created.id;

    now = new Date("2026-08-01T18:00:00.000Z");
    expect(await service.cleanupExpired()).toBe(1);
    expect(await database.founderResearchExports.getOwned(createdId, OWNER)).toBeUndefined();
  });
});
