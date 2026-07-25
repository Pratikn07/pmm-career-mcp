import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const START = "2026-07-25T18:00:00.000Z";

const database: TestCareerDatabase = await createTestDatabase();

afterEach(async () => await database.resetForTests());
afterAll(async () => await database.close());

async function seedExport(now: () => Date) {
  const company = await database.companies.upsert({
    ycId: "capability-acme",
    name: "Capability Acme",
    websiteUrl: "https://capability-acme.example/",
    checkedAt: START
  });
  const created = await database.founderResearchRuns.create({
    ownerSubject: OWNER,
    queryJson: {},
    requestedLimit: 1,
    companyIds: [company.id]
  });
  const exports = await import("../../src/founder-research/export-service.js");
  let privateMetadata: { capability: string; expiresAt: string } | undefined;
  const exportMetadata = await exports.createFounderResearchExportService(database, { subject: OWNER, now })
    .createExport(
      { runId: created.run.id, idempotencyKey: "capability-export" },
      (metadata) => { privateMetadata = metadata; }
    );
  if (privateMetadata === undefined) throw new Error("Private export metadata was not issued");
  return { exportMetadata, privateMetadata };
}

async function downloadService(now: () => Date, subject = OWNER) {
  const module = await import("../../src/founder-research/download-capability.js");
  return module.createFounderExportDownloadService(database, { subject, now });
}

describe("founder export download capabilities", () => {
  it("authorizes repeatable downloads for fifteen minutes without consuming the capability", async () => {
    let now = new Date(START);
    const created = await seedExport(() => now);
    const service = await downloadService(() => now);
    const first = await service.download(created.exportMetadata.id, created.privateMetadata.capability);
    const second = await service.download(created.exportMetadata.id, created.privateMetadata.capability);

    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.checksumSha256).toBe(created.exportMetadata.checksumSha256);
    const recorded = await queryTestDatabase<{ last_downloaded_at: string | null }>(database, `
      select last_downloaded_at
      from career_mcp.founder_export_download_capabilities
      where export_id = '${created.exportMetadata.id}'
    `);
    expect(recorded).toEqual([{ last_downloaded_at: null }]);

    now = new Date("2026-07-25T18:14:59.999Z");
    await expect(service.download(created.exportMetadata.id, created.privateMetadata.capability))
      .resolves.toMatchObject({ checksumSha256: created.exportMetadata.checksumSha256 });
    now = new Date("2026-07-25T18:15:00.000Z");
    await expect(service.download(created.exportMetadata.id, created.privateMetadata.capability))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a wrong export or owner and fails closed when stored bytes do not match their checksum", async () => {
    const created = await seedExport(() => new Date(START));
    const service = await downloadService(() => new Date(START));
    await expect(service.download("33333333-3333-4333-8333-333333333333", created.privateMetadata.capability))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await downloadService(() => new Date(START), OTHER_OWNER)).download(
      created.exportMetadata.id,
      created.privateMetadata.capability
    )).rejects.toMatchObject({ code: "NOT_FOUND" });

    await queryTestDatabase(database, `
      update career_mcp.founder_research_exports
      set checksum_sha256 = '${"0".repeat(64)}'
      where id = '${created.exportMetadata.id}'
    `);
    await expect(service.download(created.exportMetadata.id, created.privateMetadata.capability))
      .rejects.toMatchObject({ code: "DATA_INTEGRITY" });
  });
});
