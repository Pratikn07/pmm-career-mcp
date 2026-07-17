import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";

const db = (await createDatabase(":memory:"));
afterEach(async () => (await db.resetForTests()));
afterAll(async () => (await db.close()));

async function addTarget(name = "Ada Example", status = "discovered") {
  const company = (await db.companies.upsert({
    ycId: `acme-${name}`,
    name: `Acme ${name}`,
    batch: "W24",
    status: "Active",
    websiteUrl: "https://acme.example",
    checkedAt: "2026-07-16T00:00:00.000Z"
  }));
  const person = (await db.people.upsert({
    companyId: company.id,
    name,
    role: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z"
  }));
  const target = (await db.targets.upsert({
    personId: person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    totalScore: 75,
    confidence: 0.9,
    status,
    rationale: "Strong evidence-backed fit"
  }));
  return { company, person, target };
}

async function addPost() {
  return (await db.postDrafts.createVersion({
    text: "Timestamp validation",
    visibility: "PUBLIC",
    checksum: "timestamp-checksum",
    state: "draft"
  }));
}

it("persists a target with evidence provenance", async () => {
  const company = (await db.companies.upsert({ ycId: "acme-w24", name: "Acme", batch: "W24" }));
  const person = (await db.people.upsert({ companyId: company.id, name: "Ada Example", role: "Founder" }));
  (await db.evidence.add({
    personId: person.id,
    sourceUrl: "https://acme.example/team",
    fact: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  }));
  expect((await db.people.getWithEvidence(person.id))?.evidence).toHaveLength(1);
});

describe("database lifecycle", () => {
  it("discovers migrations independently of the current working directory", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-cwd-"));
    let independentDatabase: Awaited<ReturnType<typeof createDatabase>> | undefined;

    try {
      process.chdir(temporaryDirectory);
      independentDatabase = (await createDatabase(":memory:"));
      const company = (await independentDatabase.companies.upsert({
        ycId: "cwd-independent-w24",
        name: "CWD Independent"
      }));
      expect((await independentDatabase.companies.get(company.id))?.name).toBe("CWD Independent");
    } finally {
      (await independentDatabase?.close());
      process.chdir(originalDirectory);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("runs the complete migration and enables WAL for file databases", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-db-"));
    const path = join(temporaryDirectory, "nested", "career.sqlite");
    const fileDatabase = (await createDatabase(path));

    expect("resetForTests" in fileDatabase).toBe(false);
    await fileDatabase.close();

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

  it("persists repository records after reopening a file database", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-db-"));
    const path = join(temporaryDirectory, "career.sqlite");
    const first = (await createDatabase(path));
    (await first.companies.upsert({ ycId: "persist-w24", name: "Persistent Co" }));
    (await first.close());

    const reopened = (await createDatabase(path));
    expect((await reopened.companies.getByYcId("persist-w24"))?.name).toBe("Persistent Co");
    (await reopened.close());
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("enforces foreign keys", async () => {
    await expect(db.people.upsert({
      companyId: "missing-company",
      name: "No Company",
      role: "Founder"
    })).rejects.toThrow(/FOREIGN KEY/);
  });
});

it("stores structured settings", async () => {
  const setting = (await db.settings.set("career_preferences", {
    roleKeywords: ["product marketing"],
    preferredLocations: ["San Francisco"]
  }));
  expect(setting.id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await db.settings.get("career_preferences"))).toEqual({
    roleKeywords: ["product marketing"],
    preferredLocations: ["San Francisco"]
  });
});

it("upserts company and person identities without creating duplicates", async () => {
  const firstCompany = (await db.companies.upsert({ ycId: "identity-w24", name: "Old Name" }));
  const secondCompany = (await db.companies.upsert({ ycId: "identity-w24", name: "New Name" }));
  const firstPerson = (await db.people.upsert({
    companyId: firstCompany.id,
    name: "Ada Example",
    role: "Founder"
  }));
  const secondPerson = (await db.people.upsert({
    companyId: firstCompany.id,
    name: "Ada Example",
    role: "Founder"
  }));

  expect(secondCompany).toMatchObject({ id: firstCompany.id, name: "New Name" });
  expect(secondPerson.id).toBe(firstPerson.id);
  expect((await db.companies.list())).toHaveLength(1);
  expect((await db.people.listByCompany(firstCompany.id))).toHaveLength(1);
});

it("saves targets, filters the pipeline, and appends notes", async () => {
  const { company, target } = (await addTarget());
  (await db.notes.add({ targetId: target.id, text: "Met at a PMM event" }));
  (await db.notes.add({ targetId: target.id, text: "Follow up next week" }));
  (await db.targets.updateStatus(target.id, "shortlisted"));

  expect((await db.targets.list({ companyId: company.id, status: "shortlisted" }))).toHaveLength(1);
  expect((await db.targets.getByPerson(target.personId))?.id).toBe(target.id);
  expect((await db.notes.listForTarget(target.id)).map((note) => note.text)).toEqual([
    "Met at a PMM event",
    "Follow up next week"
  ]);
});

it("creates immutable outreach draft versions with evidence IDs", async () => {
  const { person, target } = (await addTarget());
  const source = (await db.evidence.add({
    personId: person.id,
    sourceUrl: "https://acme.example/team",
    fact: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  }));
  const first = (await db.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello Ada",
    evidenceIds: [source.id]
  }));
  const second = (await db.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello Ada — revised",
    evidenceIds: [source.id]
  }));

  expect(second.version).toBe(2);
  expect((await db.outreachDrafts.getVersion(target.id, "connection_note", 1))).toMatchObject({
    text: first.text,
    evidenceIds: [source.id]
  });
  expect((await db.outreachDrafts.listForTarget(target.id))).toHaveLength(2);
});

it("preserves shortlist ordering", async () => {
  const first = (await addTarget("Ada One")).target;
  const second = (await addTarget("Ada Two")).target;
  const shortlist = (await db.shortlists.create({
    name: "Weekly shortlist",
    targetIds: [second.id, first.id]
  }));

  expect((await db.shortlists.getWithEntries(shortlist.id))?.entries.map((entry) => entry.targetId)).toEqual([
    second.id,
    first.id
  ]);
  expect((await db.shortlists.list())).toEqual([shortlist]);
});

it("creates immutable post draft versions", async () => {
  const first = (await db.postDrafts.createVersion({
    text: "First",
    visibility: "PUBLIC",
    checksum: "checksum-1",
    state: "draft"
  }));
  const second = (await db.postDrafts.createVersion({
    draftId: first.draftId,
    text: "Second",
    visibility: "PUBLIC",
    checksum: "checksum-2",
    state: "draft"
  }));

  expect(second.version).toBe(2);
  expect((await db.postDrafts.getVersion(first.draftId, 1))?.text).toBe("First");
  expect((await db.postDrafts.getVersion(first.draftId, 2))?.text).toBe("Second");
  expect((await db.postDrafts.listVersions(first.draftId)).map((draft) => draft.version)).toEqual([1, 2]);
});

it("consumes a preview at most once", async () => {
  const post = (await db.postDrafts.createVersion({
    text: "Preview me",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "ready_for_preview"
  }));
  (await db.previews.create({
    postDraftId: post.id,
    version: post.version,
    tokenHash: "token-hash",
    expiresAt: "2026-07-16T00:15:00.000Z"
  }));

  expect((await db.previews.getByTokenHash("token-hash"))?.consumedAt).toBeNull();
  expect((await db.previews.consume("token-hash", "2026-07-16T00:05:00.000Z"))?.consumedAt).toBe(
    "2026-07-16T00:05:00.000Z"
  );
  expect((await db.previews.consume("token-hash", "2026-07-16T00:06:00.000Z"))).toBeUndefined();
});

it("rejects a preview version that does not match its post draft row", async () => {
  const post = (await db.postDrafts.createVersion({
    text: "Preview exact version",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "ready_for_preview"
  }));

  await expect(db.previews.create({
    postDraftId: post.id,
    version: post.version + 1,
    tokenHash: "mismatched-preview-version",
    expiresAt: "2026-07-16T00:15:00.000Z"
  })).rejects.toThrow(/FOREIGN KEY/);
});

it("records publish attempts against an exact post version", async () => {
  const post = (await db.postDrafts.createVersion({
    text: "Publish me",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "draft"
  }));
  const pending = (await db.publishAttempts.record({
    postDraftId: post.id,
    version: post.version,
    requestedAt: "2026-07-16T00:00:00.000Z",
    responseCategory: "pending"
  }));
  const completed = (await db.publishAttempts.updateResult(pending.id, {
    responseCategory: "published",
    postUrn: "urn:li:share:123",
    completedAt: "2026-07-16T00:00:01.000Z"
  }));

  expect((await db.publishAttempts.listForPostDraft(post.id))).toEqual([completed]);
});

it("rejects a publish-attempt version that does not match its post draft row", async () => {
  const post = (await db.postDrafts.createVersion({
    text: "Publish exact version",
    visibility: "PUBLIC",
    checksum: "checksum",
    state: "draft"
  }));

  await expect(db.publishAttempts.record({
    postDraftId: post.id,
    version: post.version + 1,
    requestedAt: "2026-07-16T00:00:00.000Z",
    responseCategory: "pending"
  })).rejects.toThrow(/FOREIGN KEY/);
});

it("stores OAuth secrets only in ciphertext fields", async () => {
  (await db.oauthTokens.upsert({
    provider: "linkedin",
    ciphertext: "encrypted-token-envelope",
    refreshMetadataCiphertext: "encrypted-refresh-metadata",
    expiresAt: "2026-08-16T00:00:00.000Z"
  }));

  expect((await db.oauthTokens.getByProvider("linkedin"))).toMatchObject({
    provider: "linkedin",
    ciphertext: "encrypted-token-envelope",
    refreshMetadataCiphertext: "encrypted-refresh-metadata"
  });
});

describe("ISO timestamp invariants", () => {
  const invalidTimestamp = "not-an-iso-timestamp";

  it.each([
    ["company checkedAt", async () => {
      (await db.companies.upsert({
        ycId: "invalid-company-time",
        name: "Invalid Company Time",
        checkedAt: invalidTimestamp
      }));
    }],
    ["person checkedAt", async () => {
      const company = (await db.companies.upsert({
        ycId: "invalid-person-time",
        name: "Invalid Person Time"
      }));
      (await db.people.upsert({
        companyId: company.id,
        name: "Invalid Person Time",
        role: "Founder",
        checkedAt: invalidTimestamp
      }));
    }],
    ["evidence checkedAt", async () => {
      const company = (await db.companies.upsert({
        ycId: "invalid-evidence-time",
        name: "Invalid Evidence Time"
      }));
      const person = (await db.people.upsert({
        companyId: company.id,
        name: "Invalid Evidence Time",
        role: "Founder"
      }));
      (await db.evidence.add({
        personId: person.id,
        sourceUrl: "https://example.com/evidence",
        fact: "Founder",
        checkedAt: invalidTimestamp,
        confidence: 0.8
      }));
    }]
  ])("rejects a non-ISO %s", async (_label, action) => {
    await expect(action()).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO preview expiry", async () => {
    const post = (await addPost());
    await expect(db.previews.create({
      postDraftId: post.id,
      version: post.version,
      tokenHash: "invalid-preview-expiry",
      expiresAt: invalidTimestamp
    })).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO preview consumption time", async () => {
    const post = (await addPost());
    (await db.previews.create({
      postDraftId: post.id,
      version: post.version,
      tokenHash: "invalid-preview-consumption",
      expiresAt: "2026-07-16T00:15:00.000Z"
    }));
    await expect(db.previews.consume(
      "invalid-preview-consumption",
      invalidTimestamp
    )).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO publish request time", async () => {
    const post = (await addPost());
    await expect(db.publishAttempts.record({
      postDraftId: post.id,
      version: post.version,
      requestedAt: invalidTimestamp,
      responseCategory: "pending"
    })).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO publish completion time when recording", async () => {
    const post = (await addPost());
    await expect(db.publishAttempts.record({
      postDraftId: post.id,
      version: post.version,
      requestedAt: "2026-07-16T00:00:00.000Z",
      responseCategory: "published",
      completedAt: invalidTimestamp
    })).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO publish completion time when updating", async () => {
    const post = (await addPost());
    const attempt = (await db.publishAttempts.record({
      postDraftId: post.id,
      version: post.version,
      requestedAt: "2026-07-16T00:00:00.000Z",
      responseCategory: "pending"
    }));
    await expect(db.publishAttempts.updateResult(attempt.id, {
      responseCategory: "published",
      completedAt: invalidTimestamp
    })).rejects.toThrow(/ISO timestamp/);
  });

  it("rejects a non-ISO OAuth token expiry", async () => {
    await expect(db.oauthTokens.upsert({
      provider: "linkedin",
      ciphertext: "ciphertext",
      expiresAt: invalidTimestamp
    })).rejects.toThrow(/ISO timestamp/);
  });
});
