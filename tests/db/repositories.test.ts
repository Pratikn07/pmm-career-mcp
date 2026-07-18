import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresErrorKind } from "../../src/domain/errors.js";
import { computePostChecksum } from "../../src/drafts/service.js";
import { createRepositories } from "../../src/db/repositories.js";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

let db: TestCareerDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterEach(async () => (await db.resetForTests()));
afterAll(async () => (await db?.close()));

async function addTarget(name = "Ada Example") {
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
  it("migrates exactly the thirteen application tables into the private schema", async () => {
    const tables = await queryTestDatabase<{ table_name: string }>(db, `
      select table_name
      from information_schema.tables
      where table_schema = 'career_mcp'
        and table_type = 'BASE TABLE'
      order by table_name
    `);

    expect(tables.map((row) => row.table_name)).toEqual([
      "companies",
      "evidence",
      "oauth_tokens",
      "outreach_drafts",
      "people",
      "post_drafts",
      "post_previews",
      "publish_attempts",
      "settings",
      "shortlist_entries",
      "shortlists",
      "target_notes",
      "targets"
    ]);
  });

  it("discovers migrations independently of the current working directory", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-mcp-cwd-"));
    let independentDatabase: TestCareerDatabase | undefined;

    try {
      process.chdir(temporaryDirectory);
      independentDatabase = await createTestDatabase();
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

  it("uses native PostgreSQL types for identifiers, timestamps, values, and scores", async () => {
    const columns = await queryTestDatabase<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(db, `
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'career_mcp'
        and (
          (table_name = 'settings' and column_name in ('id', 'value_json', 'updated_at'))
          or (table_name = 'companies' and column_name = 'is_hiring')
          or (table_name = 'evidence' and column_name = 'confidence')
          or (table_name = 'outreach_drafts' and column_name = 'version')
          or (table_name = 'post_drafts' and column_name = 'version')
        )
      order by table_name, column_name
    `);

    expect(columns).toEqual([
      { table_name: "companies", column_name: "is_hiring", data_type: "boolean" },
      { table_name: "evidence", column_name: "confidence", data_type: "double precision" },
      { table_name: "outreach_drafts", column_name: "version", data_type: "integer" },
      { table_name: "post_drafts", column_name: "version", data_type: "integer" },
      { table_name: "settings", column_name: "id", data_type: "uuid" },
      { table_name: "settings", column_name: "updated_at", data_type: "timestamp with time zone" },
      { table_name: "settings", column_name: "value_json", data_type: "jsonb" }
    ]);
  });

  it("uses native UUIDs for every identifier column", async () => {
    const mismatches = await queryTestDatabase<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(db, `
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'career_mcp'
        and (column_name = 'id' or column_name like '%\\_id' escape '\\')
        and column_name <> 'yc_id'
        and data_type <> 'uuid'
      order by table_name, column_name
    `);
    expect(mismatches).toEqual([]);
  });

  it("preserves composite version uniqueness and exact-version foreign keys", async () => {
    const constraints = await queryTestDatabase<{
      constraint_name: string;
      constraint_type: string;
      columns: string;
    }>(db, `
      select
        tc.constraint_name,
        tc.constraint_type,
        string_agg(kcu.column_name, ',' order by kcu.ordinal_position) as columns
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_schema = tc.constraint_schema
       and kcu.constraint_name = tc.constraint_name
      where tc.constraint_schema = 'career_mcp'
        and tc.constraint_name in (
          'post_draft_version_unique',
          'post_draft_row_version_unique',
          'post_previews_exact_version_fk',
          'publish_attempts_exact_version_fk'
        )
      group by tc.constraint_name, tc.constraint_type
      order by tc.constraint_name
    `);

    expect(constraints).toEqual([
      {
        constraint_name: "post_draft_row_version_unique",
        constraint_type: "UNIQUE",
        columns: "id,version"
      },
      {
        constraint_name: "post_draft_version_unique",
        constraint_type: "UNIQUE",
        columns: "draft_id,version"
      },
      {
        constraint_name: "post_previews_exact_version_fk",
        constraint_type: "FOREIGN KEY",
        columns: "post_draft_id,version"
      },
      {
        constraint_name: "publish_attempts_exact_version_fk",
        constraint_type: "FOREIGN KEY",
        columns: "post_draft_id,version"
      }
    ]);
  });

  it("keeps application tables out of the public schema", async () => {
    const tables = await queryTestDatabase<{ count: number }>(db, `
      select count(*)::integer as count
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'settings', 'companies', 'people', 'evidence', 'targets', 'target_notes',
          'outreach_drafts', 'shortlists', 'shortlist_entries', 'post_drafts',
          'post_previews', 'publish_attempts', 'oauth_tokens'
        )
    `);
    expect(tables).toEqual([{ count: 0 }]);
  });

  it("resets all application tables with schema-qualified truncation", async () => {
    await db.settings.set("reset-check", { persisted: true });
    await db.companies.upsert({ ycId: "reset-w24", name: "Reset Co" });

    await db.resetForTests();

    expect(await db.settings.get("reset-check")).toBeUndefined();
    expect(await db.companies.list()).toEqual([]);
  });

  it("enforces foreign keys", async () => {
    const error = await db.people.upsert({
      companyId: "00000000-0000-4000-8000-000000000001",
      name: "No Company",
      role: "Founder"
    }).then(() => undefined, (reason: unknown) => reason);

    expect(postgresErrorKind(error)).toBe("foreign_key");
  });

  it("treats malformed UUID lookup input as not found", async () => {
    expect(await db.companies.get("not-a-uuid")).toBeUndefined();
    expect(await db.people.get("not-a-uuid")).toBeUndefined();
    expect(await db.people.getWithEvidence("not-a-uuid")).toBeUndefined();
    expect(await db.evidence.get("not-a-uuid")).toBeUndefined();
    expect(await db.targets.get("not-a-uuid")).toBeUndefined();
    expect(await db.targets.getByPerson("not-a-uuid")).toBeUndefined();
    expect(await db.outreachDrafts.getVersion("not-a-uuid", "connection_note", 1)).toBeUndefined();
    expect(await db.shortlists.getWithEntries("not-a-uuid")).toBeUndefined();
    expect(await db.postDrafts.getVersion("not-a-uuid", 1)).toBeUndefined();
    expect(await db.people.listByCompany("not-a-uuid")).toEqual([]);
    expect(await db.previews.listForPostDraft("not-a-uuid")).toEqual([]);
    expect(await db.publishAttempts.listForPostDraft("not-a-uuid")).toEqual([]);
  });
});

describe("PostgreSQL transaction retries", () => {
  function databaseThatRejectsTransactions(error: unknown) {
    const transaction = vi.fn().mockRejectedValue(error);
    const repositories = createRepositories({ transaction } as never);
    return { repositories, transaction };
  }

  it.each(["40001", "40P01"])("bounds retries for SQLSTATE %s", async (code) => {
    const error = Object.assign(new Error("retryable transaction"), { code });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    await expect(repositories.postDrafts.createVersion({
      draftId: randomUUID(),
      text: "Retry me",
      visibility: "PUBLIC",
      checksum: "checksum",
      state: "draft"
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["post_draft_version_unique", "postDrafts"] as const,
    ["outreach_target_purpose_version_unique", "outreachDrafts"] as const
  ])("retries only the named %s version conflict", async (constraintName, repositoryName) => {
    const error = Object.assign(new Error("version conflict"), {
      code: "23505",
      constraint_name: constraintName
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    const operation = repositoryName === "postDrafts"
      ? repositories.postDrafts.createVersion({
          draftId: randomUUID(),
          text: "Retry me",
          visibility: "PUBLIC",
          checksum: "checksum",
          state: "draft"
        })
      : repositories.outreachDrafts.createVersion({
          targetId: randomUUID(),
          purpose: "connection_note",
          text: "Retry me",
          evidenceIds: []
        });
    await expect(operation).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unrelated unique violation", async () => {
    const error = Object.assign(new Error("unrelated conflict"), {
      code: "23505",
      constraint_name: "settings_key_unique"
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    await expect(repositories.postDrafts.createVersion({
      draftId: randomUUID(),
      text: "Do not retry",
      visibility: "PUBLIC",
      checksum: "checksum",
      state: "draft"
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

it("stores structured settings", async () => {
  const structuredValue = {
    roleKeywords: ["product marketing"],
    preferredLocations: ["San Francisco"]
  };
  const setting = (await db.settings.set("career_preferences", {
    ...structuredValue
  }));
  expect(setting.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(setting.valueJson).toEqual(structuredValue);
  expect((await db.settings.get("career_preferences"))).toEqual(structuredValue);
  const stored = await queryTestDatabase<{ value_json: unknown; value_type: string }>(db, `
    select value_json, pg_typeof(value_json)::text as value_type
    from career_mcp.settings
    where key = 'career_preferences'
  `);
  expect(stored).toEqual([{ value_json: structuredValue, value_type: "jsonb" }]);
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
  (await db.targets.updateStatus(target.id, "discovered", "shortlisted"));

  expect((await db.targets.list({ companyId: company.id, status: "shortlisted" }))).toHaveLength(1);
  expect((await db.targets.getByPerson(target.personId))?.id).toBe(target.id);
  expect((await db.notes.listForTarget(target.id)).map((note) => note.text)).toEqual([
    "Met at a PMM event",
    "Follow up next week"
  ]);
});

it("rejects a stale status transition after another caller archives the target", async () => {
  const { target } = await addTarget("Atomic status target");

  const archived = await db.targets.updateStatus(target.id, "discovered", "archived");
  const staleShortlist = await db.targets.updateStatus(target.id, "discovered", "shortlisted");

  expect(archived?.status).toBe("archived");
  expect(staleShortlist).toBeUndefined();
  expect((await db.targets.get(target.id))?.status).toBe("archived");
});

it.each(["shortlisted", "archived"])(
  "keeps %s status while concurrent score refreshes update an existing target",
  async (status) => {
    const { target } = await addTarget(`Concurrent score refresh ${status}`);
    expect(await db.targets.updateStatus(target.id, "discovered", status)).toBeDefined();

    const refresh = (totalScore: number) => db.targets.upsert({
      personId: target.personId,
      pmmOpportunity: totalScore - 45,
      referralPotential: 25,
      networkValue: 20,
      totalScore,
      confidence: 0.95,
      rationale: `Refreshed rationale ${totalScore}`
    });
    await Promise.all([refresh(80), refresh(85)]);

    expect((await db.targets.get(target.id))?.status).toBe(status);
  }
);

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

it.each([0, 1])(
  "allocates concurrent outreach versions contiguously from a sequence containing %i rows",
  async (existingVersionCount) => {
    const { target } = await addTarget(`Concurrent outreach ${existingVersionCount}`);
    if (existingVersionCount === 1) {
      await db.outreachDrafts.createVersion({
        targetId: target.id,
        purpose: "connection_note",
        text: "Existing",
        evidenceIds: []
      });
    }

    const created = await Promise.all([
      db.outreachDrafts.createVersion({
        targetId: target.id,
        purpose: "connection_note",
        text: "Concurrent A",
        evidenceIds: []
      }),
      db.outreachDrafts.createVersion({
        targetId: target.id,
        purpose: "connection_note",
        text: "Concurrent B",
        evidenceIds: []
      })
    ]);

    expect(created.map((draft) => draft.version).sort((left, right) => left - right)).toEqual([
      existingVersionCount + 1,
      existingVersionCount + 2
    ]);
    expect((await db.outreachDrafts.listForTarget(target.id)).map((draft) => draft.version)).toEqual(
      Array.from({ length: existingVersionCount + 2 }, (_, index) => index + 1)
    );
  }
);

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

it("rolls back a shortlist when a later target violates its foreign key", async () => {
  const validTarget = (await addTarget("Valid shortlist target")).target;

  await expect(db.shortlists.create({
    name: "Must roll back",
    targetIds: [validTarget.id, randomUUID()]
  })).rejects.toBeDefined();

  expect(await db.shortlists.list()).toEqual([]);
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

it.each([0, 1])(
  "allocates concurrent post versions and checksums from a sequence containing %i rows",
  async (existingVersionCount) => {
    const draftId = randomUUID();
    if (existingVersionCount === 1) {
      await db.postDrafts.createVersion({
        draftId,
        text: "Existing",
        visibility: "PUBLIC",
        checksum: (version) => computePostChecksum("Existing", version),
        state: "draft"
      });
    }

    const created = await Promise.all(["Concurrent A", "Concurrent B"].map(async (text) => (
      db.postDrafts.createVersion({
        draftId,
        text,
        visibility: "PUBLIC",
        checksum: (version) => computePostChecksum(text, version),
        state: "draft"
      })
    )));

    expect(created.map((post) => post.version).sort((left, right) => left - right)).toEqual([
      existingVersionCount + 1,
      existingVersionCount + 2
    ]);
    for (const post of created) {
      expect(post.checksum).toBe(computePostChecksum(post.text, post.version));
    }
    expect((await db.postDrafts.listVersions(draftId)).map((post) => post.version)).toEqual(
      Array.from({ length: existingVersionCount + 2 }, (_, index) => index + 1)
    );
  }
);

it("rolls back a discovery refresh when a later evidence row is invalid", async () => {
  const company = await db.companies.upsert({
    ycId: "rollback-discovery-w24",
    name: "Rollback Discovery"
  });

  await expect(db.people.refreshDiscovery({
    companyId: company.id,
    people: [
      {
        name: "Valid first person",
        role: "Founder",
        checkedAt: "2026-07-16T00:00:00.000Z",
        evidence: [{
          sourceUrl: "https://example.com/valid",
          factType: "public_role",
          fact: "Founder",
          checkedAt: "2026-07-16T00:00:00.000Z",
          confidence: 0.9
        }]
      },
      {
        name: "Invalid later person",
        role: "Founder",
        checkedAt: "2026-07-16T00:00:00.000Z",
        evidence: [{
          sourceUrl: "https://example.com/invalid",
          factType: "public_role",
          fact: "Founder",
          checkedAt: "invalid-timestamp",
          confidence: 0.9
        }]
      }
    ]
  })).rejects.toThrow(/ISO timestamp/);

  expect(await db.people.listByCompany(company.id)).toEqual([]);
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
  })).rejects.toBeDefined();
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

it("rolls back a publish claim whose attempt names a different exact post version", async () => {
  const claimedPost = await db.postDrafts.createVersion({
    text: "Claim this post",
    visibility: "PUBLIC",
    checksum: "claimed-checksum",
    state: "draft"
  });
  const differentPost = await db.postDrafts.createVersion({
    text: "Do not attach the attempt here",
    visibility: "PUBLIC",
    checksum: "different-checksum",
    state: "draft"
  });
  await db.previews.create({
    postDraftId: claimedPost.id,
    version: claimedPost.version,
    tokenHash: "exact-attempt-claim",
    expiresAt: "2026-07-16T00:15:00.000Z"
  });

  await expect(db.publishAttempts.record({
    postDraftId: differentPost.id,
    version: differentPost.version,
    requestedAt: "2026-07-16T00:00:00.000Z",
    responseCategory: "pending"
  }, {
    tokenHash: "exact-attempt-claim",
    consumedAt: "2026-07-16T00:00:00.000Z",
    expected: {
      postId: claimedPost.draftId,
      versionId: claimedPost.id,
      version: claimedPost.version,
      checksum: claimedPost.checksum,
      visibility: claimedPost.visibility
    },
    allowedStates: ["draft"],
    claimState: "publishing"
  })).rejects.toThrow(/does not match preview claim/);

  expect((await db.previews.getByTokenHash("exact-attempt-claim"))?.consumedAt).toBeNull();
  expect(await db.postDrafts.getVersion(claimedPost.draftId, claimedPost.version)).toMatchObject({
    state: "draft"
  });
  expect(await db.publishAttempts.listForPostDraft(differentPost.id)).toEqual([]);
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
  })).rejects.toBeDefined();
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

  it("normalizes database timestamptz values to canonical ISO strings", async () => {
    const company = await db.companies.upsert({
      ycId: "canonical-time-w24",
      name: "Canonical Time"
    });
    await queryTestDatabase(db, `
      update career_mcp.companies
      set checked_at = '2026-07-15 17:00:00-07'
      where id = '${company.id}'
    `);

    expect((await db.companies.get(company.id))?.checkedAt).toBe("2026-07-16T00:00:00.000Z");
  });

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
