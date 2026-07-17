import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";

const db = createDatabase(":memory:");
afterEach(() => db.resetForTests());
afterAll(() => db.close());

function addTarget(name = "Ada Example", status = "discovered") {
  const company = db.companies.upsert({
    ycId: `acme-${name}`,
    name: `Acme ${name}`,
    batch: "W24",
    status: "Active",
    websiteUrl: "https://acme.example",
    checkedAt: "2026-07-16T00:00:00.000Z"
  });
  const person = db.people.upsert({
    companyId: company.id,
    name,
    role: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z"
  });
  const target = db.targets.upsert({
    personId: person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    totalScore: 75,
    confidence: 0.9,
    status,
    rationale: "Strong evidence-backed fit"
  });
  return { company, person, target };
}

it("persists a target with evidence provenance", () => {
  const company = db.companies.upsert({ ycId: "acme-w24", name: "Acme", batch: "W24" });
  const person = db.people.upsert({ companyId: company.id, name: "Ada Example", role: "Founder" });
  db.evidence.add({
    personId: person.id,
    sourceUrl: "https://acme.example/team",
    fact: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  });
  expect(db.people.getWithEvidence(person.id)?.evidence).toHaveLength(1);
});

describe("database lifecycle", () => {
  it("runs the complete migration and enables WAL for file databases", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-db-"));
    const path = join(temporaryDirectory, "nested", "career.sqlite");
    const fileDatabase = createDatabase(path);

    expect("resetForTests" in fileDatabase).toBe(false);
    fileDatabase.close();

    const sqlite = new BetterSqlite3(path);
    const tableNames = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all().map((row) => (row as { name: string }).name);
    const journalMode = sqlite.pragma("journal_mode", { simple: true });
    sqlite.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });

    expect(tableNames).toEqual(expect.arrayContaining([
      "settings",
      "companies",
      "people",
      "evidence",
      "targets",
      "target_notes",
      "outreach_drafts",
      "shortlists",
      "shortlist_entries",
      "post_drafts",
      "post_previews",
      "publish_attempts",
      "oauth_tokens"
    ]));
    expect(journalMode).toBe("wal");
  });

  it("persists repository records after reopening a file database", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-db-"));
    const path = join(temporaryDirectory, "career.sqlite");
    const first = createDatabase(path);
    first.companies.upsert({ ycId: "persist-w24", name: "Persistent Co" });
    first.close();

    const reopened = createDatabase(path);
    expect(reopened.companies.getByYcId("persist-w24")?.name).toBe("Persistent Co");
    reopened.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("enforces foreign keys", () => {
    expect(() => db.people.upsert({
      companyId: "missing-company",
      name: "No Company",
      role: "Founder"
    })).toThrow(/FOREIGN KEY/);
  });
});

it("stores structured settings", () => {
  const setting = db.settings.set("career_preferences", {
    roleKeywords: ["product marketing"],
    preferredLocations: ["San Francisco"]
  });
  expect(setting.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(db.settings.get("career_preferences")).toEqual({
    roleKeywords: ["product marketing"],
    preferredLocations: ["San Francisco"]
  });
});

it("upserts company and person identities without creating duplicates", () => {
  const firstCompany = db.companies.upsert({ ycId: "identity-w24", name: "Old Name" });
  const secondCompany = db.companies.upsert({ ycId: "identity-w24", name: "New Name" });
  const firstPerson = db.people.upsert({
    companyId: firstCompany.id,
    name: "Ada Example",
    role: "Founder"
  });
  const secondPerson = db.people.upsert({
    companyId: firstCompany.id,
    name: "Ada Example",
    role: "Founder"
  });

  expect(secondCompany).toMatchObject({ id: firstCompany.id, name: "New Name" });
  expect(secondPerson.id).toBe(firstPerson.id);
  expect(db.companies.list()).toHaveLength(1);
  expect(db.people.listByCompany(firstCompany.id)).toHaveLength(1);
});

it("saves targets, filters the pipeline, and appends notes", () => {
  const { company, target } = addTarget();
  db.notes.add({ targetId: target.id, text: "Met at a PMM event" });
  db.notes.add({ targetId: target.id, text: "Follow up next week" });
  db.targets.updateStatus(target.id, "shortlisted");

  expect(db.targets.list({ companyId: company.id, status: "shortlisted" })).toHaveLength(1);
  expect(db.targets.getByPerson(target.personId)?.id).toBe(target.id);
  expect(db.notes.listForTarget(target.id).map((note) => note.text)).toEqual([
    "Met at a PMM event",
    "Follow up next week"
  ]);
});

it("creates immutable outreach draft versions with evidence IDs", () => {
  const { person, target } = addTarget();
  const source = db.evidence.add({
    personId: person.id,
    sourceUrl: "https://acme.example/team",
    fact: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  });
  const first = db.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello Ada",
    evidenceIds: [source.id]
  });
  const second = db.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello Ada — revised",
    evidenceIds: [source.id]
  });

  expect(second.version).toBe(2);
  expect(db.outreachDrafts.getVersion(target.id, "connection_note", 1)).toMatchObject({
    text: first.text,
    evidenceIds: [source.id]
  });
  expect(db.outreachDrafts.listForTarget(target.id)).toHaveLength(2);
});

it("preserves shortlist ordering", () => {
  const first = addTarget("Ada One").target;
  const second = addTarget("Ada Two").target;
  const shortlist = db.shortlists.create({
    name: "Weekly shortlist",
    targetIds: [second.id, first.id]
  });

  expect(db.shortlists.getWithEntries(shortlist.id)?.entries.map((entry) => entry.targetId)).toEqual([
    second.id,
    first.id
  ]);
  expect(db.shortlists.list()).toEqual([shortlist]);
});

it("creates immutable post draft versions", () => {
  const first = db.postDrafts.createVersion({
    text: "First",
    visibility: "PUBLIC",
    checksum: "checksum-1",
    state: "draft"
  });
  const second = db.postDrafts.createVersion({
    draftId: first.draftId,
    text: "Second",
    visibility: "PUBLIC",
    checksum: "checksum-2",
    state: "draft"
  });

  expect(second.version).toBe(2);
  expect(db.postDrafts.getVersion(first.draftId, 1)?.text).toBe("First");
  expect(db.postDrafts.getVersion(first.draftId, 2)?.text).toBe("Second");
  expect(db.postDrafts.listVersions(first.draftId).map((draft) => draft.version)).toEqual([1, 2]);
});

it("consumes a preview at most once", () => {
  const post = db.postDrafts.createVersion({
    text: "Preview me",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "ready_for_preview"
  });
  db.previews.create({
    postDraftId: post.id,
    version: post.version,
    tokenHash: "token-hash",
    expiresAt: "2026-07-16T00:15:00.000Z"
  });

  expect(db.previews.getByTokenHash("token-hash")?.consumedAt).toBeNull();
  expect(db.previews.consume("token-hash", "2026-07-16T00:05:00.000Z")?.consumedAt).toBe(
    "2026-07-16T00:05:00.000Z"
  );
  expect(db.previews.consume("token-hash", "2026-07-16T00:06:00.000Z")).toBeUndefined();
});

it("records publish attempts against an exact post version", () => {
  const post = db.postDrafts.createVersion({
    text: "Publish me",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "draft"
  });
  const pending = db.publishAttempts.record({
    postDraftId: post.id,
    version: post.version,
    requestedAt: "2026-07-16T00:00:00.000Z",
    responseCategory: "pending"
  });
  const completed = db.publishAttempts.updateResult(pending.id, {
    responseCategory: "published",
    postUrn: "urn:li:share:123",
    completedAt: "2026-07-16T00:00:01.000Z"
  });

  expect(db.publishAttempts.listForPostDraft(post.id)).toEqual([completed]);
});

it("stores OAuth secrets only in ciphertext fields", () => {
  db.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: "encrypted-token-envelope",
    refreshMetadataCiphertext: "encrypted-refresh-metadata",
    expiresAt: "2026-08-16T00:00:00.000Z"
  });

  expect(db.oauthTokens.getByProvider("linkedin")).toMatchObject({
    provider: "linkedin",
    ciphertext: "encrypted-token-envelope",
    refreshMetadataCiphertext: "encrypted-refresh-metadata"
  });
});
