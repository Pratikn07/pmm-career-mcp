import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError, postgresErrorKind } from "../../src/domain/errors.js";
import { computePostChecksum } from "../../src/drafts/service.js";
import { createRepositories } from "../../src/db/repositories.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase,
  type TestQueryLogEntry
} from "../support/database.js";

let db: TestCareerDatabase;
const DEFAULT_POST_OWNER = "123e4567-e89b-42d3-a456-426614174000";
const queryLog: TestQueryLogEntry[] = [];
beforeAll(async () => {
  db = await createTestDatabase({ queryLog });
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
    ownerSubject: DEFAULT_POST_OWNER,
    text: "Timestamp validation",
    visibility: "PUBLIC",
    checksum: "timestamp-checksum",
    state: "draft"
  }));
}

async function addMedia(input: {
  ownerSubject: string;
  sha256?: string;
  originalFilename?: string;
  width?: number;
  height?: number;
}) {
  const id = randomUUID();
  const sha256 = input.sha256 ?? randomUUID().replaceAll("-", "").padEnd(64, "0");
  return await db.postMedia.create({
    id,
    ownerSubject: input.ownerSubject,
    objectPath: `${input.ownerSubject}/${sha256.slice(0, 2)}/${id}.png`,
    sha256,
    mimeType: "image/png",
    byteSize: 1024,
    width: input.width ?? 1200,
    height: input.height ?? 627,
    frameCount: 1,
    ...(input.originalFilename === undefined
      ? {}
      : { originalFilename: input.originalFilename })
  });
}

async function addOwnedPost(ownerSubject: string) {
  const media = await addMedia({ ownerSubject });
  return (await db.postDrafts.createVersionWithMedia({
    ownerSubject,
    text: "Owner-scoped brand brief source",
    visibility: "PUBLIC",
    checksum: "owner-scoped-brand-brief-source",
    state: "draft",
    media: [{ mediaId: media.id, altText: "Owner-scoped source image" }]
  })).post;
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
  it("migrates exactly the thirty application tables into the private schema", async () => {
    const tables = await queryTestDatabase<{ table_name: string }>(db, `
      select table_name
      from information_schema.tables
      where table_schema = 'career_mcp'
        and table_type = 'BASE TABLE'
      order by table_name
    `);

    expect(tables.map((row) => row.table_name)).toEqual([
      "brand_brief_source_claims",
      "brand_profiles",
      "brand_visual_briefs",
      "brand_visual_renders",
      "companies",
      "evidence",
      "founder_export_download_capabilities",
      "founder_profile_candidates",
      "founder_profile_confirmation_events",
      "founder_research_exports",
      "founder_research_run_items",
      "founder_research_run_people",
      "founder_research_runs",
      "media_usage_claims",
      "oauth_tokens",
      "outreach_drafts",
      "people",
      "post_draft_media",
      "post_draft_owners",
      "post_drafts",
      "post_media",
      "post_previews",
      "publish_attempt_media",
      "publish_attempts",
      "runtime_role_owners",
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
          or (table_name = 'post_previews' and column_name = 'snapshot_checksum')
          or (table_name = 'post_media' and column_name in ('owner_subject', 'byte_size', 'created_at'))
          or (table_name = 'publish_attempts' and column_name in ('phase', 'media_count'))
        )
      order by table_name, column_name
    `);

    expect(columns).toEqual([
      { table_name: "companies", column_name: "is_hiring", data_type: "boolean" },
      { table_name: "evidence", column_name: "confidence", data_type: "double precision" },
      { table_name: "outreach_drafts", column_name: "version", data_type: "integer" },
      { table_name: "post_drafts", column_name: "version", data_type: "integer" },
      { table_name: "post_media", column_name: "byte_size", data_type: "bigint" },
      { table_name: "post_media", column_name: "created_at", data_type: "timestamp with time zone" },
      { table_name: "post_media", column_name: "owner_subject", data_type: "uuid" },
      { table_name: "post_previews", column_name: "snapshot_checksum", data_type: "text" },
      { table_name: "publish_attempts", column_name: "media_count", data_type: "integer" },
      { table_name: "publish_attempts", column_name: "phase", data_type: "text" },
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
        and column_name not in ('yc_id', 'template_id', 'request_id')
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
          'post_draft_media_exact_version_fk',
          'post_previews_exact_version_fk',
          'publish_attempts_exact_version_fk',
          'brand_visual_briefs_post_version_fk',
          'brand_visual_briefs_profile_version_fk'
        )
      group by tc.constraint_name, tc.constraint_type
      order by tc.constraint_name
    `);

    expect(constraints).toEqual(expect.arrayContaining([
      {
        constraint_name: "brand_visual_briefs_post_version_fk",
        constraint_type: "FOREIGN KEY",
        columns: "post_draft_id,post_version"
      },
      {
        constraint_name: "brand_visual_briefs_profile_version_fk",
        constraint_type: "FOREIGN KEY",
        columns: "brand_profile_id,brand_profile_version"
      },
      {
        constraint_name: "post_draft_media_exact_version_fk",
        constraint_type: "FOREIGN KEY",
        columns: "post_draft_id,version"
      },
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
    ]));
  });

  it("keeps application tables out of the public schema", async () => {
    const tables = await queryTestDatabase<{ count: number }>(db, `
      select count(*)::integer as count
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'settings', 'companies', 'people', 'evidence', 'targets', 'target_notes',
          'outreach_drafts', 'shortlists', 'shortlist_entries', 'post_drafts',
          'brand_brief_source_claims', 'brand_profiles', 'brand_visual_briefs',
          'brand_visual_renders',
          'post_draft_media', 'post_media', 'post_previews', 'publish_attempt_media',
          'publish_attempts', 'oauth_tokens'
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

  it("resets founder research and export rows in child-to-parent order", async () => {
    const ownerSubject = randomUUID();
    const runId = randomUUID();
    const runItemId = randomUUID();
    const runPersonId = randomUUID();
    const candidateId = randomUUID();
    const exportId = randomUUID();
    const company = await db.companies.upsert({
      ycId: `reset-founder-${randomUUID()}`,
      name: "Reset Founder Co"
    });
    const person = await db.people.upsert({
      companyId: company.id,
      name: "Reset Founder",
      role: "Founder"
    });

    for (const statement of [
      `insert into career_mcp.founder_research_runs (
        id, owner_subject, state, query_json, requested_limit,
        selected_count, processed_count, complete_count, partial_count,
        ambiguous_count, not_found_count, failed_count, created_at, updated_at
      ) values (
        '${runId}', '${ownerSubject}', 'COMPLETE', '{}'::jsonb, 1,
        1, 1, 1, 0, 0, 0, 0, now(), now()
      )`,
      `insert into career_mcp.founder_research_run_items (
        id, run_id, owner_subject, company_id, state, attempt_count, created_at, updated_at
      ) values (
        '${runItemId}', '${runId}', '${ownerSubject}', '${company.id}',
        'COMPLETE', 1, now(), now()
      )`,
      `insert into career_mcp.founder_research_run_people (
        id, run_item_id, owner_subject, person_id, identity_status,
        founder_role_match, confidence, created_at, updated_at
      ) values (
        '${runPersonId}', '${runItemId}', '${ownerSubject}', '${person.id}',
        'VERIFIED', 'founder', 1, now(), now()
      )`,
      `insert into career_mcp.founder_profile_candidates (
        id, run_person_id, owner_subject, profile_url, status, source_kind,
        evidence_url, checked_at, confidence, evidence_metadata_json, created_at, updated_at
      ) values (
        '${candidateId}', '${runPersonId}', '${ownerSubject}',
        'https://www.linkedin.com/in/reset-founder', 'VERIFIED',
        'OFFICIAL_COMPANY', 'https://example.com/team', now(), 1, '{}'::jsonb,
        now(), now()
      )`,
      `insert into career_mcp.founder_profile_confirmation_events (
        id, candidate_id, owner_subject, event, created_at
      ) values (
        '${randomUUID()}', '${candidateId}', '${ownerSubject}', 'CONFIRMED', now()
      )`,
      `insert into career_mcp.founder_research_exports (
        id, run_id, owner_subject, state, file_name, mime_type, byte_size,
        checksum_sha256, workbook_bytes, row_count, sheet_count, created_at, expires_at
      ) values (
        '${exportId}', '${runId}', '${ownerSubject}', 'READY', 'reset.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        1, '${"a".repeat(64)}', decode('00', 'hex'), 0, 1, now(), now() + interval '1 day'
      )`,
      `insert into career_mcp.founder_export_download_capabilities (
        id, export_id, owner_subject, token_hash_sha256, expires_at, created_at
      ) values (
        '${randomUUID()}', '${exportId}', '${ownerSubject}', '${"b".repeat(64)}',
        now() + interval '15 minutes', now()
      )
      `
    ]) {
      await queryTestDatabase(db, statement);
    }

    await db.resetForTests();

    const remaining = await queryTestDatabase<{ count: number }>(db, `
      select count(*)::integer as count
      from (
        select id from career_mcp.founder_export_download_capabilities
        union all select id from career_mcp.founder_profile_confirmation_events
        union all select id from career_mcp.founder_profile_candidates
        union all select id from career_mcp.founder_research_exports
        union all select id from career_mcp.founder_research_run_people
        union all select id from career_mcp.founder_research_run_items
        union all select id from career_mcp.founder_research_runs
      ) rows
    `);
    expect(remaining).toEqual([{ count: 0 }]);
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
    expect(await db.postMedia.get("not-a-uuid")).toBeUndefined();
    expect(await db.postMedia.getByOwnerAndSha("not-a-uuid", "a".repeat(64))).toBeUndefined();
    expect(await db.people.listByCompany("not-a-uuid")).toEqual([]);
    expect(await db.postDraftMedia.listForVersion("not-a-uuid", 1)).toEqual([]);
    expect(await db.previews.listForPostDraft("not-a-uuid")).toEqual([]);
    expect(await db.publishAttemptMedia.listForAttempt("not-a-uuid")).toEqual([]);
    expect(await db.publishAttempts.listForPostDraft("not-a-uuid")).toEqual([]);
  });
});

describe("founder research repositories", () => {
  const OWNER = "123e4567-e89b-42d3-a456-426614174101";
  const OTHER_OWNER = "123e4567-e89b-42d3-a456-426614174102";
  const STARTED_AT = "2099-07-24T16:00:00.000Z";
  const LEASE_EXPIRES_AT = "2099-07-24T16:05:00.000Z";
  const ACTIVE_LEASE_EXPIRES_AT = "2099-07-24T16:15:00.000Z";
  const CHECKED_AT = "2099-07-24T16:10:00.000Z";

  async function addFounderCompanies(names: readonly string[]) {
    return await Promise.all(names.map(async (name) => await db.companies.upsert({
      ycId: `founder-${name.toLowerCase().replaceAll(" ", "-")}-${randomUUID()}`,
      name,
      batch: "W24",
      status: "Active",
      websiteUrl: `https://${name.toLowerCase().replaceAll(" ", "")}.example`
    })));
  }

  async function addFounderRun(
    names: readonly string[] = ["Gamma", "Alpha", "Beta"],
    ownerSubject = OWNER
  ) {
    const companies = await addFounderCompanies(names);
    const created = await db.founderResearchRuns.create({
      ownerSubject,
      queryJson: { batch: "W24", hiring: true },
      requestedLimit: Math.max(1, companies.length),
      companyIds: companies.map(({ id }) => id)
    });
    return { ...created, companies };
  }

  async function addRunPerson(input: {
    ownerSubject?: string;
    companyName?: string;
    personName?: string;
  } = {}) {
    const ownerSubject = input.ownerSubject ?? OWNER;
    const created = await addFounderRun([input.companyName ?? "Canonical"], ownerSubject);
    const leased = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject,
      maxItems: 1,
      leasedAt: STARTED_AT,
      leaseExpiresAt: ACTIVE_LEASE_EXPIRES_AT
    });
    const item = leased[0]!;
    const person = await db.people.upsert({
      companyId: item.companyId,
      name: input.personName ?? "Ada Founder",
      role: "Co-founder"
    });
    const runPerson = await db.founderResearchPeople.saveOfficial({
      runItemId: item.id,
      ownerSubject,
      personId: person.id,
      founderRoleMatch: "co-founder",
      confidence: 0.98
    });
    return { ...created, item, person, runPerson, ownerSubject };
  }

  it("creates immutable run membership and hides another owner's run", async () => {
    const created = await addFounderRun();

    expect(created.run.selectedCount).toBe(3);
    expect(created.items).toHaveLength(3);
    expect(await db.founderResearchRuns.getOwned(created.run.id, OTHER_OWNER)).toBeUndefined();

    const replacement = (await addFounderCompanies(["Replacement"]))[0]!;
    const mutation = await queryTestDatabase(db, `
      update career_mcp.founder_research_run_items
      set company_id = '${replacement.id}'
      where id = '${created.items[0]!.id}'
    `).then(() => undefined, (error: unknown) => error);
    expect(mutation).toBeInstanceOf(Error);
  });

  it("leases deterministically, clamps the batch to five, and increments attempts", async () => {
    const created = await addFounderRun([
      "Zulu",
      "Bravo",
      "Echo",
      "Alpha",
      "Delta",
      "Charlie",
      "Foxtrot"
    ]);

    const leased = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 50,
      leasedAt: STARTED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT
    });

    const companyNames = new Map(created.companies.map((company) => [company.id, company.name]));
    expect(leased.map(({ companyId }) => companyNames.get(companyId))).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo"
    ]);
    expect(leased).toHaveLength(5);
    expect(leased.every((item) => (
      item.state === "LEASED"
      && item.attemptCount === 1
      && item.leaseExpiresAt === LEASE_EXPIRES_AT
    ))).toBe(true);
  });

  it("recovers expired leases and never leases one item to two callers", async () => {
    const created = await addFounderRun(["One", "Two", "Three", "Four"]);
    const first = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 2,
      leasedAt: STARTED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT
    });

    expect(await db.founderResearchRuns.releaseExpiredLeases({
      runId: created.run.id,
      ownerSubject: OWNER,
      now: "2099-07-24T16:04:59.999Z"
    })).toBe(0);
    expect(await db.founderResearchRuns.releaseExpiredLeases({
      runId: created.run.id,
      ownerSubject: OWNER,
      now: LEASE_EXPIRES_AT
    })).toBe(2);

    const [left, right] = await Promise.all([
      db.founderResearchRuns.leaseNextItems({
        runId: created.run.id,
        ownerSubject: OWNER,
        maxItems: 3,
        leasedAt: "2099-07-24T16:06:00.000Z",
        leaseExpiresAt: "2099-07-24T16:11:00.000Z"
      }),
      db.founderResearchRuns.leaseNextItems({
        runId: created.run.id,
        ownerSubject: OWNER,
        maxItems: 3,
        leasedAt: "2099-07-24T16:06:00.000Z",
        leaseExpiresAt: "2099-07-24T16:11:00.000Z"
      })
    ]);
    const leasedIds = [...left, ...right].map(({ id }) => id);
    expect(new Set(leasedIds).size).toBe(leasedIds.length);
    expect(new Set(leasedIds)).toEqual(new Set(created.items.map(({ id }) => id)));
    expect(first.every(({ attemptCount }) => attemptCount === 1)).toBe(true);
    const recovered = [...left, ...right].filter(({ id }) => first.some((item) => item.id === id));
    expect(recovered.every(({ attemptCount }) => attemptCount === 2)).toBe(true);
  });

  it("isolates item failures and derives all run counters from item state", async () => {
    const created = await addFounderRun(["Complete", "Partial", "Missing", "Ambiguous", "Failed"]);
    const leased = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 5,
      leasedAt: STARTED_AT,
      leaseExpiresAt: ACTIVE_LEASE_EXPIRES_AT
    });

    await db.founderResearchRuns.completeItem({
      itemId: leased[0]!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased[0]!.attemptCount,
      state: "COMPLETE",
      checkedAt: CHECKED_AT
    });
    await db.founderResearchRuns.completeItem({
      itemId: leased[1]!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased[1]!.attemptCount,
      state: "PARTIAL",
      checkedAt: CHECKED_AT
    });
    await db.founderResearchRuns.completeItem({
      itemId: leased[2]!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased[2]!.attemptCount,
      state: "NOT_FOUND",
      checkedAt: CHECKED_AT
    });
    await db.founderResearchRuns.completeItem({
      itemId: leased[3]!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased[3]!.attemptCount,
      state: "AMBIGUOUS",
      checkedAt: CHECKED_AT
    });
    await db.founderResearchRuns.failItem({
      itemId: leased[4]!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased[4]!.attemptCount,
      checkedAt: CHECKED_AT,
      errorCode: "OFFICIAL_SOURCE_UNAVAILABLE",
      errorSummary: "Official site did not respond",
      errorDetailJson: { retryable: false }
    });

    const run = await db.founderResearchRuns.recomputeCounters(created.run.id, OWNER);
    expect(run).toMatchObject({
      state: "PARTIAL",
      selectedCount: 5,
      processedCount: 5,
      completeCount: 1,
      partialCount: 1,
      ambiguousCount: 1,
      notFoundCount: 1,
      failedCount: 1
    });
    const rows = await queryTestDatabase<{ state: string; error_code: string | null }>(db, `
      select state, error_code
      from career_mcp.founder_research_run_items
      where run_id = '${created.run.id}'
      order by state
    `);
    expect(rows.filter(({ state }) => state === "FAILED")).toEqual([{
      state: "FAILED",
      error_code: "OFFICIAL_SOURCE_UNAVAILABLE"
    }]);
    expect(rows).toHaveLength(5);
  });

  it("rejects pending, expired, stale-generation, and terminal item completion", async () => {
    const created = await addFounderRun(["Guarded"]);
    const pending = created.items[0]!;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(STARTED_AT));
      expect(await db.founderResearchRuns.completeItem({
        itemId: pending.id,
        ownerSubject: OWNER,
        leaseAttempt: 0,
        state: "COMPLETE",
        checkedAt: STARTED_AT
      })).toBeUndefined();

      const [firstLease] = await db.founderResearchRuns.leaseNextItems({
        runId: created.run.id,
        ownerSubject: OWNER,
        maxItems: 1,
        leasedAt: STARTED_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT
      });
      vi.setSystemTime(new Date(LEASE_EXPIRES_AT));
      expect(await db.founderResearchRuns.completeItem({
        itemId: firstLease!.id,
        ownerSubject: OWNER,
        leaseAttempt: firstLease!.attemptCount,
        state: "COMPLETE",
        checkedAt: "2099-07-24T16:04:00.000Z"
      })).toBeUndefined();

      vi.setSystemTime(new Date("2099-07-24T16:06:00.000Z"));
      const [secondLease] = await db.founderResearchRuns.leaseNextItems({
        runId: created.run.id,
        ownerSubject: OWNER,
        maxItems: 1,
        leasedAt: "2099-07-24T16:06:00.000Z",
        leaseExpiresAt: ACTIVE_LEASE_EXPIRES_AT
      });
      expect(secondLease!.attemptCount).toBe(firstLease!.attemptCount + 1);
      vi.setSystemTime(new Date(CHECKED_AT));
      expect(await db.founderResearchRuns.failItem({
        itemId: firstLease!.id,
        ownerSubject: OWNER,
        leaseAttempt: firstLease!.attemptCount,
        checkedAt: CHECKED_AT,
        errorCode: "STALE_WORKER",
        errorSummary: "The old worker must not win"
      })).toBeUndefined();

      const completed = await db.founderResearchRuns.completeItem({
        itemId: secondLease!.id,
        ownerSubject: OWNER,
        leaseAttempt: secondLease!.attemptCount,
        state: "COMPLETE",
        checkedAt: CHECKED_AT
      });
      expect(completed?.state).toBe("COMPLETE");
      expect(await db.founderResearchRuns.failItem({
        itemId: secondLease!.id,
        ownerSubject: OWNER,
        leaseAttempt: secondLease!.attemptCount,
        checkedAt: "2099-07-24T16:11:00.000Z",
        errorCode: "LATE_FAILURE",
        errorSummary: "Terminal state must be immutable"
      })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    const stored = await queryTestDatabase<{
      state: string;
      attempt_count: number;
      error_code: string | null;
    }>(db, `
      select state, attempt_count, error_code
      from career_mcp.founder_research_run_items
      where id = '${pending.id}'
    `);
    expect(stored).toEqual([{
      state: "COMPLETE",
      attempt_count: 2,
      error_code: null
    }]);
  });

  it("atomically rejects an expired discovery outcome before any founder data is written", async () => {
    const created = await addFounderRun(["Atomic Stale"]);
    const [leased] = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 1,
      leasedAt: STARTED_AT,
      leaseExpiresAt: LEASE_EXPIRES_AT
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(LEASE_EXPIRES_AT));
      const committed = await db.founderResearchRuns.commitDiscoveryOutcome({
        itemId: leased!.id,
        ownerSubject: OWNER,
        leaseAttempt: leased!.attemptCount,
        state: "COMPLETE",
        checkedAt: "2099-07-24T16:04:59.000Z",
        founders: [{
          name: "Stale Founder",
          role: "Founder",
          checkedAt: "2099-07-24T16:04:59.000Z",
          confidence: 0.95,
          officialEvidence: {
            sourceUrl: "https://atomicstale.example/team",
            title: "Leadership",
            fact: "Stale Founder — Founder",
            checkedAt: "2099-07-24T16:04:59.000Z",
            confidence: 0.95
          },
          officialProfileUrl: "https://www.linkedin.com/in/stale-founder"
        }]
      });

      expect(committed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(await db.people.listByCompany(created.companies[0]!.id)).toEqual([]);
    expect(await db.founderResearchPeople.listForRun(created.run.id, OWNER)).toEqual([]);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_candidates
    `)).toEqual([{ count: 0 }]);
  });

  it("atomically commits official founders, evidence, profiles, and the leased item", async () => {
    const created = await addFounderRun(["Atomic Commit"]);
    const [leased] = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 1,
      leasedAt: STARTED_AT,
      leaseExpiresAt: ACTIVE_LEASE_EXPIRES_AT
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(CHECKED_AT));
      const committed = await db.founderResearchRuns.commitDiscoveryOutcome({
        itemId: leased!.id,
        ownerSubject: OWNER,
        leaseAttempt: leased!.attemptCount,
        state: "COMPLETE",
        checkedAt: CHECKED_AT,
        founders: [{
          name: "Atomic Founder",
          role: "Co-founder & CEO",
          checkedAt: CHECKED_AT,
          confidence: 0.97,
          officialEvidence: {
            sourceUrl: "https://atomiccommit.example/team",
            title: "Leadership",
            fact: "Atomic Founder — Co-founder & CEO",
            checkedAt: CHECKED_AT,
            confidence: 0.97
          },
          officialProfileUrl: "https://www.linkedin.com/in/atomic-founder"
        }]
      });

      expect(committed).toMatchObject({
        item: { state: "COMPLETE", checkedAt: CHECKED_AT },
        run: { state: "COMPLETE", completeCount: 1, processedCount: 1 },
        founders: [{
          person: {
            name: "Atomic Founder",
            publicProfileUrl: "https://www.linkedin.com/in/atomic-founder"
          },
          runPerson: {
            identityStatus: "VERIFIED",
            founderRoleMatch: "Co-founder & CEO"
          },
          officialCandidate: {
            status: "VERIFIED",
            sourceKind: "OFFICIAL_COMPANY",
            profileUrl: "https://www.linkedin.com/in/atomic-founder"
          }
        }]
      });
    } finally {
      vi.useRealTimers();
    }
    const [savedPerson] = await db.people.listByCompany(created.companies[0]!.id);
    expect((await db.people.getWithEvidence(savedPerson!.id))?.evidence).toEqual([
      expect.objectContaining({
        factType: "official_public_role",
        sourceUrl: "https://atomiccommit.example/team"
      })
    ]);
  });

  it("preserves completedAt when recomputing an unchanged terminal run", async () => {
    const created = await addFounderRun(["Stable Completion"]);
    const [leased] = await db.founderResearchRuns.leaseNextItems({
      runId: created.run.id,
      ownerSubject: OWNER,
      maxItems: 1,
      leasedAt: STARTED_AT,
      leaseExpiresAt: ACTIVE_LEASE_EXPIRES_AT
    });
    await db.founderResearchRuns.completeItem({
      itemId: leased!.id,
      ownerSubject: OWNER,
      leaseAttempt: leased!.attemptCount,
      state: "COMPLETE",
      checkedAt: CHECKED_AT
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2099-07-24T16:20:00.000Z"));
      const first = await db.founderResearchRuns.recomputeCounters(created.run.id, OWNER);
      vi.setSystemTime(new Date("2099-07-24T16:30:00.000Z"));
      const second = await db.founderResearchRuns.recomputeCounters(created.run.id, OWNER);
      expect(first?.completedAt).toBe("2099-07-24T16:20:00.000Z");
      expect(second?.completedAt).toBe(first?.completedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves official people idempotently and lists only the owned run", async () => {
    const context = await addRunPerson();
    const duplicate = await db.founderResearchPeople.saveOfficial({
      runItemId: context.item.id,
      ownerSubject: OWNER,
      personId: context.person.id,
      founderRoleMatch: "co-founder",
      confidence: 0.99
    });

    expect(duplicate.id).toBe(context.runPerson.id);
    expect(duplicate.confidence).toBe(0.99);
    expect(await db.founderResearchPeople.listForRun(context.run.id, OTHER_OWNER)).toEqual([]);
    expect(await db.founderResearchPeople.listForRun(context.run.id, OWNER)).toEqual([duplicate]);
  });

  it("deduplicates candidates and enforces CONFIRMED over VERIFIED over CANDIDATE", async () => {
    const context = await addRunPerson();
    const candidate = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-candidate",
      searchQuery: "Ada Founder Canonical LinkedIn",
      evidenceUrl: "https://search.example/result/ada",
      evidenceTitle: "Ada Founder - LinkedIn",
      evidenceSnippet: "Ada Founder at Canonical",
      evidenceMetadataJson: { provider: "public_search" },
      checkedAt: CHECKED_AT,
      confidence: 0.7
    });
    const duplicate = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-candidate",
      searchQuery: "Ada Founder Canonical LinkedIn",
      evidenceUrl: "https://search.example/result/ada",
      evidenceTitle: "Ada Founder - LinkedIn",
      evidenceSnippet: "Ada Founder at Canonical",
      evidenceMetadataJson: { provider: "public_search" },
      checkedAt: CHECKED_AT,
      confidence: 0.7
    });
    expect(duplicate.id).toBe(candidate.id);
    expect(
      await db.founderProfileCandidates.getCanonicalForPerson(context.runPerson.id, OWNER)
    ).toBeUndefined();

    const verified = await db.founderProfileCandidates.recordOfficial({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-official",
      sourceKind: "OFFICIAL_COMPANY",
      evidenceUrl: "https://canonical.example/team",
      evidenceTitle: "Team",
      evidenceSnippet: "Ada Founder, Co-founder",
      evidenceMetadataJson: { card: 1 },
      checkedAt: CHECKED_AT,
      confidence: 0.98
    });
    expect(
      (await db.founderProfileCandidates.getCanonicalForPerson(
        context.runPerson.id,
        OWNER
      ))?.id
    ).toBe(verified.id);

    const confirmed = await db.founderProfileCandidates.confirm({
      candidateId: candidate.id,
      ownerSubject: OWNER,
      note: "Manually matched company and identity",
      decidedAt: "2099-07-24T16:11:00.000Z"
    });
    expect(confirmed?.status).toBe("CONFIRMED");
    expect(
      (await db.founderProfileCandidates.getCanonicalForPerson(
        context.runPerson.id,
        OWNER
      ))?.id
    ).toBe(candidate.id);

    const laterOfficial = await db.founderProfileCandidates.recordOfficial({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-later-official",
      sourceKind: "OFFICIAL_YC",
      evidenceUrl: "https://www.ycombinator.com/companies/canonical",
      evidenceMetadataJson: {},
      checkedAt: "2099-07-24T16:12:00.000Z",
      confidence: 1
    });
    expect(laterOfficial.status).toBe("VERIFIED");
    expect(
      (await db.founderProfileCandidates.getCanonicalForPerson(
        context.runPerson.id,
        OWNER
      ))?.id
    ).toBe(candidate.id);
    expect((await db.people.get(context.person.id))?.publicProfileUrl)
      .toBe("https://www.linkedin.com/in/ada-candidate");
  });

  it("lists every candidate for one owned run person with deterministic owner isolation", async () => {
    const context = await addRunPerson({ companyName: "Candidate List" });
    const earlier = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-earlier",
      searchQuery: "Ada Founder Candidate List LinkedIn",
      evidenceUrl: "https://www.linkedin.com/in/ada-earlier",
      evidenceMetadataJson: {},
      checkedAt: CHECKED_AT,
      confidence: 0.65
    });
    const later = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-later",
      searchQuery: "Ada Founder Candidate List LinkedIn",
      evidenceUrl: "https://www.linkedin.com/in/ada-later",
      evidenceMetadataJson: {},
      checkedAt: "2099-07-24T16:11:00.000Z",
      confidence: 0.75
    });

    expect(
      (await db.founderProfileCandidates.listForPerson(
        context.runPerson.id,
        OWNER
      )).map(({ id }) => id)
    ).toEqual([later.id, earlier.id]);
    expect(
      await db.founderProfileCandidates.listForPerson(
        context.runPerson.id,
        OTHER_OWNER
      )
    ).toEqual([]);
    expect(
      await db.founderProfileCandidates.listForPerson("not-a-uuid", OWNER)
    ).toEqual([]);
  });

  it("rejects a candidate in one transaction and retains an append-only audit event", async () => {
    const context = await addRunPerson({ companyName: "Rejected" });
    const candidate = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/wrong-founder",
      searchQuery: "Ada Founder Rejected LinkedIn",
      evidenceUrl: "https://search.example/result/wrong",
      evidenceMetadataJson: {},
      checkedAt: CHECKED_AT,
      confidence: 0.55
    });

    const rejected = await db.founderProfileCandidates.reject({
      candidateId: candidate.id,
      ownerSubject: OWNER,
      note: "Different company",
      decidedAt: "2099-07-24T16:11:00.000Z"
    });
    expect(rejected?.status).toBe("REJECTED");
    const rediscovered = await db.founderProfileCandidates.saveCandidate({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/wrong-founder",
      searchQuery: "Ada Founder Rejected LinkedIn",
      evidenceUrl: "https://search.example/result/wrong",
      evidenceMetadataJson: {},
      checkedAt: "2099-07-24T16:12:00.000Z",
      confidence: 0.6
    });
    expect(rediscovered.id).toBe(candidate.id);
    expect(rediscovered.status).toBe("REJECTED");
    expect(await db.founderProfileCandidates.reject({
      candidateId: candidate.id,
      ownerSubject: OTHER_OWNER,
      decidedAt: "2099-07-24T16:12:00.000Z"
    })).toBeUndefined();

    const events = await queryTestDatabase<{
      event: string;
      note: string | null;
    }>(db, `
      select event, note
      from career_mcp.founder_profile_confirmation_events
      where candidate_id = '${candidate.id}'
    `);
    expect(events).toEqual([{ event: "REJECTED", note: "Different company" }]);
  });

  it("round-trips exact workbook bytes and checksum with owner isolation", async () => {
    const created = await addFounderRun(["Workbook"]);
    const workbookBytes = Buffer.from("PK\u0003\u0004private deterministic workbook", "utf8");
    const checksumSha256 = createHash("sha256").update(workbookBytes).digest("hex");
    const saved = await db.founderResearchExports.create({
      runId: created.run.id,
      ownerSubject: OWNER,
      fileName: "yc-founder-research.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      checksumSha256,
      workbookBytes,
      rowCount: 1,
      sheetCount: 4,
      createdAt: STARTED_AT,
      expiresAt: "2099-07-31T16:00:00.000Z"
    });

    expect(saved.byteSize).toBe(workbookBytes.byteLength);
    expect(Buffer.from(saved.workbookBytes)).toEqual(workbookBytes);
    expect(saved.checksumSha256).toBe(checksumSha256);
    expect(await db.founderResearchExports.getOwned(saved.id, OTHER_OWNER)).toBeUndefined();
    expect(Buffer.from(
      (await db.founderResearchExports.getOwned(saved.id, OWNER))!.workbookBytes
    )).toEqual(workbookBytes);
  });

  it("stores only capability hashes and supports repeat downloads during its lifetime", async () => {
    const created = await addFounderRun(["Capability"]);
    const workbookBytes = Buffer.from("PK\u0003\u0004capability workbook", "utf8");
    const checksumSha256 = createHash("sha256").update(workbookBytes).digest("hex");
    const savedExport = await db.founderResearchExports.create({
      runId: created.run.id,
      ownerSubject: OWNER,
      fileName: "capability.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      checksumSha256,
      workbookBytes,
      rowCount: 1,
      sheetCount: 4,
      createdAt: STARTED_AT,
      expiresAt: "2099-07-25T16:00:00.000Z"
    });
    const rawToken = "private-capability-token-that-must-not-be-stored";
    const tokenHashSha256 = createHash("sha256").update(rawToken).digest("hex");
    const capability = await db.founderExportCapabilities.create({
      exportId: savedExport.id,
      ownerSubject: OWNER,
      tokenHashSha256,
      createdAt: STARTED_AT,
      expiresAt: "2099-07-24T16:15:00.000Z"
    });

    const stored = await queryTestDatabase<{
      token_hash_sha256: string;
      last_downloaded_at: string | null;
    }>(db, `
      select token_hash_sha256, last_downloaded_at
      from career_mcp.founder_export_download_capabilities
      where id = '${capability.id}'
    `);
    expect(stored).toEqual([{
      token_hash_sha256: tokenHashSha256,
      last_downloaded_at: null
    }]);
    expect(JSON.stringify(stored)).not.toContain(rawToken);

    expect((await db.founderExportCapabilities.getUsable({
      exportId: savedExport.id,
      ownerSubject: OWNER,
      tokenHashSha256,
      now: "2099-07-24T16:05:00.000Z"
    }))?.capability.id).toBe(capability.id);
    const first = await db.founderExportCapabilities.recordDownload({
      capabilityId: capability.id,
      ownerSubject: OWNER,
      downloadedAt: "2099-07-24T16:05:00.000Z"
    });
    const second = await db.founderExportCapabilities.recordDownload({
      capabilityId: capability.id,
      ownerSubject: OWNER,
      downloadedAt: "2099-07-24T16:06:00.000Z"
    });
    const outOfOrder = await db.founderExportCapabilities.recordDownload({
      capabilityId: capability.id,
      ownerSubject: OWNER,
      downloadedAt: "2099-07-24T16:05:30.000Z"
    });
    expect(first?.lastDownloadedAt).toBe("2099-07-24T16:05:00.000Z");
    expect(second?.lastDownloadedAt).toBe("2099-07-24T16:06:00.000Z");
    expect(outOfOrder?.lastDownloadedAt).toBe("2099-07-24T16:06:00.000Z");
    expect((await db.founderExportCapabilities.getUsable({
      exportId: savedExport.id,
      ownerSubject: OWNER,
      tokenHashSha256,
      now: "2099-07-24T16:14:59.999Z"
    }))?.capability.lastDownloadedAt).toBe("2099-07-24T16:06:00.000Z");
    expect(await db.founderExportCapabilities.getUsable({
      exportId: savedExport.id,
      ownerSubject: OWNER,
      tokenHashSha256,
      now: "2099-07-24T16:15:00.000Z"
    })).toBeUndefined();
  });

  it("deletes only expired owned exports and their capabilities", async () => {
    const created = await addFounderRun(["Delete Export"]);
    const workbookBytes = Buffer.from("PK\u0003\u0004delete workbook", "utf8");
    const savedExport = await db.founderResearchExports.create({
      runId: created.run.id,
      ownerSubject: OWNER,
      fileName: "delete.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      checksumSha256: createHash("sha256").update(workbookBytes).digest("hex"),
      workbookBytes,
      rowCount: 1,
      sheetCount: 4,
      createdAt: STARTED_AT,
      expiresAt: "2099-07-25T16:00:00.000Z"
    });
    await db.founderExportCapabilities.create({
      exportId: savedExport.id,
      ownerSubject: OWNER,
      tokenHashSha256: "c".repeat(64),
      createdAt: STARTED_AT,
      expiresAt: "2099-07-24T16:15:00.000Z"
    });

    expect(await db.founderResearchExports.deleteExpired(
      OWNER,
      "2099-07-25T15:59:59.999Z"
    )).toBe(0);
    expect(await db.founderResearchExports.deleteExpired(
      OTHER_OWNER,
      "2099-07-25T16:00:00.000Z"
    )).toBe(0);
    expect(await db.founderResearchExports.deleteExpired(
      OWNER,
      "2099-07-25T16:00:00.000Z"
    )).toBe(1);
    expect(await db.founderResearchExports.getOwned(savedExport.id, OWNER)).toBeUndefined();
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
      ownerSubject: DEFAULT_POST_OWNER,
      text: "Retry me",
      visibility: "PUBLIC",
      checksum: "checksum",
      state: "draft"
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each(["40001", "40P01"])(
    "retries founder candidate decisions for SQLSTATE %s",
    async (code) => {
      const error = Object.assign(new Error("retryable founder decision"), { code });
      const { repositories, transaction } = databaseThatRejectsTransactions(error);

      await expect(repositories.founderProfileCandidates.confirm({
        candidateId: randomUUID(),
        ownerSubject: DEFAULT_POST_OWNER,
        decidedAt: "2099-07-24T16:00:00.000Z"
      })).rejects.toBe(error);

      expect(transaction).toHaveBeenCalledTimes(3);
    }
  );

  it.each([
    ["post_draft_version_unique", "postDrafts"] as const,
    ["outreach_target_purpose_version_unique", "outreachDrafts"] as const,
    ["brand_profiles_one_active_owner_unique", "brandProfiles"] as const
  ])("retries only the named %s version conflict", async (constraintName, repositoryName) => {
    const error = Object.assign(new Error("version conflict"), {
      code: "23505",
      constraint_name: constraintName
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    const operation = repositoryName === "postDrafts"
      ? repositories.postDrafts.createVersion({
          draftId: randomUUID(),
          ownerSubject: DEFAULT_POST_OWNER,
          text: "Retry me",
          visibility: "PUBLIC",
          checksum: "checksum",
          state: "draft"
        })
      : repositoryName === "outreachDrafts"
        ? repositories.outreachDrafts.createVersion({
            targetId: randomUUID(),
            purpose: "connection_note",
            text: "Retry me",
            evidenceIds: []
          })
        : repositories.brandProfiles.ensureDefault({
            id: randomUUID(),
            ownerSubject: randomUUID(),
            publicName: "Bhagyashree Nandoskar",
            roleLine: "Product Marketing",
            seriesName: "PMM FIELD NOTES",
            monogram: "BN",
            voiceJson: {},
            paletteJson: {},
            hookRulesJson: {}
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
      ownerSubject: DEFAULT_POST_OWNER,
      text: "Do not retry",
      visibility: "PUBLIC",
      checksum: "checksum",
      state: "draft"
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry a different Brand Studio unique violation", async () => {
    const error = Object.assign(new Error("different brand profile conflict"), {
      code: "23505",
      constraint_name: "brand_profiles_owner_version_unique"
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    await expect(repositories.brandProfiles.ensureDefault({
      id: randomUUID(),
      ownerSubject: randomUUID(),
      publicName: "Bhagyashree Nandoskar",
      roleLine: "Product Marketing",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: {},
      paletteJson: {},
      hookRulesJson: {}
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("retries the atomic profile-and-brief write only for the active-profile race", async () => {
    const activeProfileRace = Object.assign(new Error("active profile race"), {
      code: "23505",
      constraint_name: "brand_profiles_one_active_owner_unique"
    });
    const unrelatedConflict = Object.assign(new Error("unrelated brief conflict"), {
      code: "23505",
      constraint_name: "brand_visual_briefs_pkey"
    });
    const input = {
      profile: {
        id: randomUUID(),
        ownerSubject: randomUUID(),
        publicName: "BHAGYASHREE NANDOSKAR",
        roleLine: "PRODUCT MARKETING",
        seriesName: "PMM FIELD NOTES",
        monogram: "BN",
        voiceJson: {},
        paletteJson: {},
        hookRulesJson: {}
      },
      brief: {
        id: randomUUID(),
        ownerSubject: randomUUID(),
        postDraftId: randomUUID(),
        postVersion: 1,
        templateId: "editorial-statement-v1",
        templateVersion: 1,
        promptFormatVersion: 1,
        visualMode: "EDITORIAL_STATEMENT",
        coverHook: "Clarity beats capability.",
        conceptSummary: "Restrained editorial geometry",
        generationPrompt: "A text-free editorial illustration",
        negativeConstraintsJson: ["no text"],
        state: "ready"
      }
    };
    input.brief.ownerSubject = input.profile.ownerSubject;

    const retrying = databaseThatRejectsTransactions(activeProfileRace);
    await expect(
      retrying.repositories.brandVisualBriefs.createWithDefaultProfile(input)
    ).rejects.toBe(activeProfileRace);
    expect(retrying.transaction).toHaveBeenCalledTimes(3);

    const notRetrying = databaseThatRejectsTransactions(unrelatedConflict);
    await expect(
      notRetrying.repositories.brandVisualBriefs.createWithDefaultProfile(input)
    ).rejects.toBe(unrelatedConflict);
    expect(notRetrying.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    "post_draft_version_unique",
    "brand_visual_renders_brief_version_unique"
  ])("branded render retries only the named %s race", async (constraintName) => {
    const error = Object.assign(new Error("branded render race"), {
      code: "23505",
      constraint_name: constraintName
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    await expect(repositories.brandVisualRenders.commitAndAttach({
      ownerSubject: randomUUID(),
      briefId: randomUUID(),
      expectedDraftId: randomUUID(),
      expectedVersion: 1,
      renderedMediaId: randomUUID(),
      altText: "Editorial cover",
      renderChecksum: "a".repeat(64),
      rendererVersion: 1,
      checksum: () => "b".repeat(64)
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("branded render does not retry an unrelated unique violation", async () => {
    const error = Object.assign(new Error("unrelated branded render race"), {
      code: "23505",
      constraint_name: "post_media_owner_sha_unique"
    });
    const { repositories, transaction } = databaseThatRejectsTransactions(error);

    await expect(repositories.brandVisualRenders.commitAndAttach({
      ownerSubject: randomUUID(),
      briefId: randomUUID(),
      expectedDraftId: randomUUID(),
      expectedVersion: 1,
      renderedMediaId: randomUUID(),
      altText: "Editorial cover",
      renderChecksum: "a".repeat(64),
      rendererVersion: 1,
      checksum: () => "b".repeat(64)
    })).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("Brand Studio repositories", () => {
  function canonicalProfile(ownerSubject: string) {
    return {
      id: randomUUID(),
      ownerSubject,
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: {
        persona: "curious PMM practitioner",
        traits: [
          "thoughtful",
          "practical",
          "observant",
          "conversational",
          "evidence-aware"
        ],
        neverInventExperience: true
      },
      paletteJson: {
        ivory: "#F6F1E8",
        navy: "#14233A",
        copper: "#B97850",
        taupe: "#C9B8A5",
        highlight: "#FFFDF9"
      },
      hookRulesJson: {
        minWords: 2,
        maxWords: 8,
        maxCharacters: 72,
        recentWindow: 30
      }
    };
  }

  function atomicBrief(
    ownerSubject: string,
    post: { id: string; version: number },
    overrides: Record<string, unknown> = {}
  ) {
    return {
      id: randomUUID(),
      ownerSubject,
      postDraftId: post.id,
      postVersion: post.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready",
      ...overrides
    };
  }

  async function readyBrandedRender(
    ownerSubject: string,
    options: {
      visualMode?: "EDITORIAL_STATEMENT" | "EDITORIAL_METAPHOR";
    } = {}
  ) {
    const post = await addOwnedPost(ownerSubject);
    const visualMode = options.visualMode ?? "EDITORIAL_STATEMENT";
    const { profile, brief } = await db.brandVisualBriefs.createWithDefaultProfile({
      profile: canonicalProfile(ownerSubject),
      brief: atomicBrief(ownerSubject, post, {
        visualMode,
        templateId: visualMode === "EDITORIAL_STATEMENT"
          ? "editorial-statement-v1"
          : "editorial-metaphor-v1"
      })
    });
    return { post, profile, brief };
  }

  function brandedRenderInput(
    ownerSubject: string,
    source: Awaited<ReturnType<typeof readyBrandedRender>>,
    renderedMediaId: string,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      ownerSubject,
      briefId: source.brief.id,
      expectedDraftId: source.post.draftId,
      expectedVersion: source.post.version,
      renderedMediaId,
      altText: "PMM Field Notes cover reading “Clarity beats capability.”",
      renderChecksum: "a".repeat(64),
      rendererVersion: 1,
      checksum: (
        nextVersion: number,
        logicalDraftId: string,
        media: readonly {
          position: number;
          sha256: string;
          mimeType: string;
          altText: string;
        }[]
      ) => checksumLinkedInPost({
        draftId: logicalDraftId,
        version: nextVersion,
        text: source.post.text,
        visibility: source.post.visibility as "PUBLIC" | "CONNECTIONS",
        media: media.map((item) => ({
          ...item,
          mimeType: item.mimeType as "image/jpeg" | "image/png" | "image/gif"
        }))
      }),
      ...overrides
    };
  }

  it("keeps the active profile and visual briefs scoped to their owner", async () => {
    const owner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "Bhagyashree Nandoskar",
      roleLine: "Product Marketing",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8 }
    });
    const existing = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "Different name",
      roleLine: "Different role",
      seriesName: "Different series",
      monogram: "DN",
      voiceJson: {},
      paletteJson: {},
      hookRulesJson: {}
    });
    const post = await addOwnedPost(owner);
    const createBrief = async (coverHook: string) => db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId: post.id,
      postVersion: post.version,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook,
      conceptSummary: "A concise visual concept",
      topicLabel: "Product marketing",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });
    const first = await createBrief("Start with the audience");
    const second = await createBrief("Then sharpen the message");
    await queryTestDatabase(db, `
      update career_mcp.brand_visual_briefs
      set created_at = '2026-07-22T10:00:00.000Z'
      where id = '${first.id}'
    `);
    await queryTestDatabase(db, `
      update career_mcp.brand_visual_briefs
      set created_at = '2026-07-22T10:01:00.000Z'
      where id = '${second.id}'
    `);

    expect(profile.version).toBe(1);
    expect(existing).toEqual(profile);
    expect((await db.brandProfiles.getActive(owner))?.id).toBe(profile.id);
    expect(await db.brandProfiles.getActive(randomUUID())).toBeUndefined();
    expect(await db.brandProfiles.getActive("not-a-uuid")).toBeUndefined();
    expect(await db.brandVisualBriefs.getOwned(first.id, owner)).toMatchObject({ id: first.id });
    expect(await db.brandVisualBriefs.getOwned(first.id, randomUUID())).toBeUndefined();
    expect(await db.brandVisualBriefs.getOwned("not-a-uuid", owner)).toBeUndefined();
    expect((await db.brandVisualBriefs.listRecent(owner, 10)).map(({ id }) => id)).toEqual([
      second.id,
      first.id
    ]);
    expect((await db.brandVisualBriefs.listRecent(owner, 0)).map(({ id }) => id)).toEqual([
      second.id
    ]);
    expect((await db.brandVisualBriefs.listRecent(owner, 100)).map(({ id }) => id)).toEqual([
      second.id,
      first.id
    ]);
    expect(await db.brandVisualBriefs.listRecent("not-a-uuid", 10)).toEqual([]);
  });

  it("rejects absent and foreign post versions with the same safe error", async () => {
    const owner = randomUUID();
    const foreignOwner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "Bhagyashree Nandoskar",
      roleLine: "Product Marketing",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8 }
    });
    const foreignPost = await addOwnedPost(foreignOwner);
    const createBrief = (postDraftId: string, postVersion: number) => db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId,
      postVersion,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Start with the audience",
      conceptSummary: "A concise visual concept",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });
    const rejection = async (postDraftId: string, postVersion: number) => {
      const error = await createBrief(postDraftId, postVersion).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      return {
        code: domainError.code,
        message: domainError.message,
        details: domainError.details
      };
    };

    const foreign = await rejection(foreignPost.id, foreignPost.version);
    const absent = await rejection(randomUUID(), 1);

    expect(foreign).toEqual(absent);
    expect(foreign).toEqual({
      code: "NOT_FOUND",
      message: "Brand visual brief source was not found",
      details: { entity: "post_draft" }
    });
  });

  it("atomically rejects a no-longer-latest owned post version and accepts the latest", async () => {
    const owner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8 }
    });
    const first = await addOwnedPost(owner);
    const firstMedia = await db.postDraftMedia.listForVersion(first.id, first.version);
    const second = (await db.postDrafts.createVersionWithMedia({
      draftId: first.draftId,
      expectedVersion: first.version,
      ownerSubject: owner,
      text: "Latest owner-scoped brand brief source",
      visibility: "PUBLIC",
      checksum: "latest-owner-scoped-brand-brief-source",
      state: "draft",
      media: firstMedia.map(({ mediaId, altText }) => ({ mediaId, altText }))
    })).post;
    const createBrief = (postDraftId: string, postVersion: number) => db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId,
      postVersion,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });

    queryLog.length = 0;
    const staleError = await createBrief(first.id, first.version).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(staleError).toBeInstanceOf(DomainError);
    expect(staleError).toMatchObject({
      code: "CONFLICT",
      message: "Post draft version is stale",
      details: {
        entity: "post_draft",
        expectedVersion: first.version,
        actualVersion: second.version
      }
    });

    queryLog.length = 0;
    await expect(createBrief(second.id, second.version)).resolves.toMatchObject({
      postDraftId: second.id,
      postVersion: second.version
    });
    const lockQueries = queryLog.filter(({ query }) => /for update/i.test(query));
    const latestLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_drafts"')
      && query.includes('order by "career_mcp"."post_drafts"."version" desc')
      && !query.includes('join "career_mcp"."post_draft_media"')
    ));
    const exactPostLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_drafts"')
      && !query.includes('order by "career_mcp"."post_drafts"."version" desc')
      && !query.includes('join ')
    ));
    const draftMediaLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_draft_media"')
      && !query.includes('join ')
      && query.includes('order by "career_mcp"."post_draft_media"."position" asc')
    ));
    const mediaLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_media"')
      && query.includes('order by "career_mcp"."post_media"."id" asc')
    ));
    const profileLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."brand_profiles"')
    ));
    const recentHooksLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."brand_visual_briefs"')
    ));
    expect(latestLockIndex).toBeGreaterThanOrEqual(0);
    expect(exactPostLockIndex).toBeGreaterThan(latestLockIndex);
    expect(draftMediaLockIndex).toBeGreaterThan(exactPostLockIndex);
    expect(mediaLockIndex).toBeGreaterThan(draftMediaLockIndex);
    expect(profileLockIndex).toBeGreaterThan(mediaLockIndex);
    expect(recentHooksLockIndex).toBeGreaterThan(profileLockIndex);
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toHaveLength(1);
  });

  it("atomically initializes the canonical profile and first brief", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const result = await db.brandVisualBriefs.createWithDefaultProfile({
      profile: canonicalProfile(owner),
      brief: atomicBrief(owner, post)
    });

    expect(result.profile).toMatchObject({
      ownerSubject: owner,
      version: 1,
      state: "active",
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING"
    });
    expect(result.brief).toMatchObject({
      ownerSubject: owner,
      brandProfileId: result.profile.id,
      brandProfileVersion: 1,
      postDraftId: post.id,
      postVersion: post.version
    });
    expect(await db.brandProfiles.getActive(owner)).toEqual(result.profile);
    expect(await db.brandVisualBriefs.getOwned(result.brief.id, owner)).toEqual(result.brief);
  });

  it("rolls back first-profile initialization when the first brief insert fails", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const error = await db.brandVisualBriefs.createWithDefaultProfile({
      profile: canonicalProfile(owner),
      brief: atomicBrief(owner, post, { visualMode: "INVALID_MODE" })
    }).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(TypeError);
    expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
  });

  it("serializes simultaneous identical owner hooks to one saved brief", async () => {
    const owner = randomUUID();
    const firstPost = await addOwnedPost(owner);
    const secondPost = await addOwnedPost(owner);
    const results = await Promise.allSettled([
      db.brandVisualBriefs.createWithDefaultProfile({
        profile: canonicalProfile(owner),
        brief: atomicBrief(owner, firstPost)
      }),
      db.brandVisualBriefs.createWithDefaultProfile({
        profile: canonicalProfile(owner),
        brief: atomicBrief(owner, secondPost)
      })
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "VALIDATION_ERROR",
        details: { field: "coverHook", reason: "recent_duplicate" }
      }
    });
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toHaveLength(1);
    expect(await db.brandProfiles.getActive(owner)).toBeDefined();
  });

  it("serializes simultaneous post-version and first-brief creation without an orphan profile", async () => {
    const owner = randomUUID();
    const media = await addMedia({ ownerSubject: owner });
    const first = (await db.postDrafts.createVersionWithMedia({
      ownerSubject: owner,
      text: "Initial version for concurrent brand brief",
      visibility: "PUBLIC",
      checksum: "concurrent-brand-brief-v1",
      state: "draft",
      media: [{ mediaId: media.id, altText: "Private source" }]
    })).post;

    const [versionResult, briefResult] = await Promise.allSettled([
      db.postDrafts.createVersionWithMedia({
        draftId: first.draftId,
        expectedVersion: first.version,
        ownerSubject: owner,
        text: "New version racing the first brand brief",
        visibility: "PUBLIC",
        checksum: "concurrent-brand-brief-v2",
        state: "draft",
        media: [{ mediaId: media.id, altText: "Private source" }]
      }),
      db.brandVisualBriefs.createWithDefaultProfile({
        profile: canonicalProfile(owner),
        brief: atomicBrief(owner, first)
      })
    ]);

    expect(versionResult.status).toBe("fulfilled");
    if (briefResult.status === "rejected") {
      expect(briefResult.reason).toMatchObject({
        code: "CONFLICT",
        message: "Post draft version is stale",
        details: {
          entity: "post_draft",
          expectedVersion: first.version,
          actualVersion: first.version + 1
        }
      });
      expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
      expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
    } else {
      expect(briefResult.value.brief).toMatchObject({
        postDraftId: first.id,
        postVersion: first.version
      });
      expect(await db.brandProfiles.getActive(owner)).toEqual(briefResult.value.profile);
      expect(await db.brandVisualBriefs.listRecent(owner, 30)).toHaveLength(1);
    }
  });

  it("does not link a brief when the active profile differs from the canonical input", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    await db.brandProfiles.ensureDefault({
      ...canonicalProfile(owner),
      publicName: "NONCANONICAL NAME"
    });

    await expect(db.brandVisualBriefs.createWithDefaultProfile({
      profile: canonicalProfile(owner),
      brief: atomicBrief(owner, post)
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand profile configuration is invalid",
      details: { entity: "brand_profile" }
    });
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
  });

  it("rejects exact hook reuse inside the latest thirty owner briefs", async () => {
    const owner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8, recentWindow: 30 }
    });
    const post = await addOwnedPost(owner);
    const createBrief = () => db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId: post.id,
      postVersion: post.version,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });
    await createBrief();

    const error = await createBrief().then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Cover hook does not meet the brand rules.",
      details: { field: "coverHook", reason: "recent_duplicate" }
    });
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toHaveLength(1);
  });

  it("returns render provenance only for the owning subject", async () => {
    const owner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "Bhagyashree Nandoskar",
      roleLine: "Product Marketing",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8 }
    });
    const post = await addOwnedPost(owner);
    const brief = await db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId: post.id,
      postVersion: post.version,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Start with the audience",
      conceptSummary: "A concise visual concept",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });
    const renderedMedia = await addMedia({ ownerSubject: owner });
    const renderId = randomUUID();
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, rendered_media_id, alt_text,
        render_checksum, renderer_version, created_at
      ) values (
        '${renderId}', '${owner}', '${brief.id}', 1, '${renderedMedia.id}', 'Editorial cover',
        '${"a".repeat(64)}', 1, '2026-07-22T10:00:00.000Z'
      )
    `);

    expect(await db.brandVisualRenders.getByRenderedMedia(owner, renderedMedia.id)).toMatchObject({
      id: renderId,
      renderedMediaSha256: renderedMedia.sha256,
      brief: { id: brief.id },
      profile: { id: profile.id }
    });
    expect(await db.brandVisualRenders.getByRenderedMedia(randomUUID(), renderedMedia.id)).toBeUndefined();
    expect(await db.brandVisualRenders.getByRenderedMedia("not-a-uuid", renderedMedia.id)).toBeUndefined();
    expect(await db.brandVisualRenders.getByRenderedMedia(owner, "not-a-uuid")).toBeUndefined();
  });

  it("does not return a render whose rendered media belongs to another owner", async () => {
    const owner = randomUUID();
    const profile = await db.brandProfiles.ensureDefault({
      ownerSubject: owner,
      id: randomUUID(),
      publicName: "Bhagyashree Nandoskar",
      roleLine: "Product Marketing",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      voiceJson: { persona: "curious PMM practitioner" },
      paletteJson: { ivory: "#F6F1E8" },
      hookRulesJson: { minWords: 2, maxWords: 8 }
    });
    const post = await addOwnedPost(owner);
    const brief = await db.brandVisualBriefs.create({
      id: randomUUID(),
      ownerSubject: owner,
      postDraftId: post.id,
      postVersion: post.version,
      brandProfileId: profile.id,
      brandProfileVersion: profile.version,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Start with the audience",
      conceptSummary: "A concise visual concept",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    });
    const foreignMedia = await addMedia({ ownerSubject: randomUUID() });
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, rendered_media_id, alt_text,
        render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${owner}', '${brief.id}', 1, '${foreignMedia.id}', 'Editorial cover',
        '${"b".repeat(64)}', 1, '2026-07-22T10:00:00.000Z'
      )
    `);

    expect(await db.brandVisualRenders.getByRenderedMedia(owner, foreignMedia.id)).toBeUndefined();
  });

  it("branded render atomically creates one immutable final-cover version without preview or publish rows", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const sourceMedia = await addMedia({
      ownerSubject: owner,
      sha256: "b".repeat(64)
    });
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      originalFilename: "brand-cover.png",
      width: 1080,
      height: 1350
    });
    queryLog.length = 0;

    const result = await db.brandVisualRenders.commitAndAttach(
      brandedRenderInput(owner, source, finalMedia.id, {
        sourceMediaId: sourceMedia.id
      })
    );

    expect(result.post).toMatchObject({
      draftId: source.post.draftId,
      text: source.post.text,
      visibility: source.post.visibility,
      version: source.post.version + 1,
      state: "draft"
    });
    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(2);
    expect(await db.postDraftMedia.listForVersion(result.post.id, result.post.version))
      .toEqual([expect.objectContaining({
        position: 0,
        mediaId: finalMedia.id,
        altText: "PMM Field Notes cover reading “Clarity beats capability.”",
        sha256: finalMedia.sha256,
        mimeType: "image/png"
      })]);
    const sourceAttachments = await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.post_draft_media
      where media_id = '${sourceMedia.id}'
    `);
    expect(sourceAttachments).toEqual([{ count: 0 }]);
    expect(result.render).toMatchObject({
      ownerSubject: owner,
      briefId: source.brief.id,
      version: 1,
      sourceMediaId: sourceMedia.id,
      renderedMediaId: finalMedia.id,
      altText: "PMM Field Notes cover reading “Clarity beats capability.”",
      renderChecksum: finalMedia.sha256,
      rendererVersion: 1
    });
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "rendered" });
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.post_previews
    `)).toEqual([{ count: 0 }]);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.publish_attempts
    `)).toEqual([{ count: 0 }]);

    const lockQueries = queryLog.filter(({ query }) => /for update/i.test(query));
    const lockIndex = (table: string, extra = "") => lockQueries.findIndex(({ query }) => (
      query.includes(`from "career_mcp"."${table}"`) && query.includes(extra)
    ));
    const latestPostLock = lockIndex(
      "post_drafts",
      'order by "career_mcp"."post_drafts"."version" desc'
    );
    const exactPostLock = lockQueries.findIndex(({ query }, index) => (
      index > latestPostLock
      && query.includes('from "career_mcp"."post_drafts"')
      && !query.includes('order by "career_mcp"."post_drafts"."version" desc')
    ));
    const draftMediaLock = lockIndex("post_draft_media");
    const mediaLock = lockIndex(
      "post_media",
      'order by "career_mcp"."post_media"."id" asc'
    );
    const profileLock = lockIndex("brand_profiles");
    const briefLock = lockIndex("brand_visual_briefs");
    expect(latestPostLock).toBeGreaterThanOrEqual(0);
    expect(exactPostLock).toBe(-1);
    expect(draftMediaLock).toBeGreaterThan(latestPostLock);
    expect(mediaLock).toBeGreaterThan(draftMediaLock);
    expect(profileLock).toBeGreaterThan(mediaLock);
    expect(briefLock).toBeGreaterThan(profileLock);
    const lockedMediaIds = lockQueries[mediaLock]?.params as string[];
    expect(lockedMediaIds).toEqual([...lockedMediaIds].sort());
    expect(lockedMediaIds).toEqual(
      expect.arrayContaining([
        sourceMedia.id.toLowerCase(),
        finalMedia.id.toLowerCase()
      ])
    );
  });

  it("branded render returns the same non-leaking NOT_FOUND for absent and foreign briefs", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const foreign = await readyBrandedRender(otherOwner);
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    const rejection = async (briefId: string) => {
      const error = await db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, foreign, finalMedia.id, { briefId })
      ).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    };

    const foreignError = await rejection(foreign.brief.id);
    const absentError = await rejection(randomUUID());

    expect({
      code: foreignError.code,
      message: foreignError.message,
      details: foreignError.details
    }).toEqual({
      code: absentError.code,
      message: absentError.message,
      details: absentError.details
    });
    expect(foreignError).toMatchObject({
      code: "NOT_FOUND",
      message: "Brand visual brief was not found",
      details: { entity: "brand_visual_brief" }
    });
    expect(await db.postDrafts.listVersions(foreign.post.draftId)).toHaveLength(1);
  });

  it("branded render hides attached, unattached, and absent foreign source media identically", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const foreignPost = await addOwnedPost(otherOwner);
    const [attachedForeign] = await db.postDraftMedia.listForVersion(
      foreignPost.id,
      foreignPost.version
    );
    const unattachedForeign = await addMedia({
      ownerSubject: otherOwner,
      sha256: "b".repeat(64)
    });
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    const rejection = async (sourceMediaId: string) => {
      const error = await db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, finalMedia.id, { sourceMediaId })
      ).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      return {
        code: domainError.code,
        message: domainError.message,
        details: domainError.details
      };
    };

    const attached = await rejection(attachedForeign!.mediaId);
    const unattached = await rejection(unattachedForeign.id);
    const absent = await rejection(randomUUID());

    expect(attached).toEqual(unattached);
    expect(attached).toEqual(absent);
    expect(attached).toEqual({
      code: "NOT_FOUND",
      message: "Brand render media was not found",
      details: { entity: "post_media" }
    });
  });

  it("owner validation still hides a foreign or absent source reused as rendered media", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const foreign = await addMedia({
      ownerSubject: otherOwner,
      sha256: "b".repeat(64),
      width: 1080,
      height: 1350
    });
    const rejection = async (mediaId: string) => {
      const error = await db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, mediaId, { sourceMediaId: mediaId })
      ).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      return {
        code: domainError.code,
        message: domainError.message,
        details: domainError.details
      };
    };

    const foreignError = await rejection(foreign.id);
    const absentError = await rejection(randomUUID());

    expect(foreignError).toEqual(absentError);
    expect(foreignError).toEqual({
      code: "NOT_FOUND",
      message: "Brand render media was not found",
      details: { entity: "post_media" }
    });
  });

  it("branded render rejects a stale exact post before any mutation", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner);
    const sourceMedia = await db.postDraftMedia.listForVersion(
      source.post.id,
      source.post.version
    );
    const latest = (await db.postDrafts.createVersionWithMedia({
      draftId: source.post.draftId,
      expectedVersion: source.post.version,
      ownerSubject: owner,
      text: "A newer immutable version",
      visibility: "PUBLIC",
      state: "draft",
      media: sourceMedia.map(({ mediaId, altText }) => ({ mediaId, altText })),
      checksum: "newer-version"
    })).post;
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });

    queryLog.length = 0;
    await expect(db.brandVisualRenders.commitAndAttach(
      brandedRenderInput(owner, source, finalMedia.id)
    )).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Post draft version is stale",
      details: {
        entity: "post_draft",
        expectedVersion: source.post.version,
        actualVersion: latest.version
      }
    });

    const staleLocks = queryLog.filter(({ query }) => /for update/i.test(query));
    const stalePostLocks = staleLocks.filter(({ query }) => (
      query.includes('from "career_mcp"."post_drafts"')
    ));
    expect(stalePostLocks).toHaveLength(1);
    expect(stalePostLocks[0]?.query).toContain(
      'order by "career_mcp"."post_drafts"."version" desc'
    );
    expect(staleLocks.some(({ query }) => (
      query.includes('from "career_mcp"."post_draft_media"')
    ))).toBe(false);
    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(2);
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "ready" });
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.brand_visual_renders
    `)).toEqual([{ count: 0 }]);
  });

  it("validates exact and latest post-media lineage before revealing stale version details", async () => {
    const rejection = async (
      lineage: "foreign_exact" | "unattached_exact" | "absent_exact" | "foreign_latest"
    ) => {
      const owner = randomUUID();
      const otherOwner = randomUUID();
      const source = await readyBrandedRender(owner);
      const finalMedia = await addMedia({
        ownerSubject: owner,
        sha256: "a".repeat(64),
        width: 1080,
        height: 1350
      });
      let expectedDraftId = source.post.draftId;

      if (lineage === "foreign_exact") {
        const foreignFirst = await addOwnedPost(otherOwner);
        const foreignMedia = await db.postDraftMedia.listForVersion(
          foreignFirst.id,
          foreignFirst.version
        );
        await db.postDrafts.createVersionWithMedia({
          draftId: foreignFirst.draftId,
          ownerSubject: otherOwner,
          text: "Foreign newer version",
          visibility: "PUBLIC",
          state: "draft",
          checksum: "foreign-newer-version",
          media: foreignMedia.map(({ mediaId, altText }) => ({ mediaId, altText }))
        });
        expectedDraftId = foreignFirst.draftId;
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs disable trigger all"
        );
        await queryTestDatabase(db, `
          update career_mcp.brand_visual_briefs
          set post_draft_id = '${foreignFirst.id}', post_version = 1
          where id = '${source.brief.id}'
        `);
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs enable trigger all"
        );
      } else if (lineage === "unattached_exact") {
        const unattachedFirst = await db.postDrafts.createVersion({
          ownerSubject: source.post.ownerSubject,
          text: "Unattached exact source",
          visibility: "PUBLIC",
          state: "draft",
          checksum: "unattached-exact"
        });
        await db.postDrafts.createVersion({
          draftId: unattachedFirst.draftId,
          ownerSubject: source.post.ownerSubject,
          text: "Unattached latest source",
          visibility: "PUBLIC",
          state: "draft",
          checksum: "unattached-latest"
        });
        expectedDraftId = unattachedFirst.draftId;
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs disable trigger all"
        );
        await queryTestDatabase(db, `
          update career_mcp.brand_visual_briefs
          set post_draft_id = '${unattachedFirst.id}', post_version = 1
          where id = '${source.brief.id}'
        `);
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs enable trigger all"
        );
      } else if (lineage === "absent_exact") {
        const absentPostId = randomUUID();
        expectedDraftId = randomUUID();
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs disable trigger all"
        );
        await queryTestDatabase(db, `
          update career_mcp.brand_visual_briefs
          set post_draft_id = '${absentPostId}', post_version = 1
          where id = '${source.brief.id}'
        `);
        await queryTestDatabase(
          db,
          "alter table career_mcp.brand_visual_briefs enable trigger all"
        );
      } else {
        const foreignLatestMedia = await addMedia({
          ownerSubject: otherOwner,
          sha256: "b".repeat(64)
        });
        const latestPostId = randomUUID();
        await queryTestDatabase(db, `
          insert into career_mcp.post_drafts (
            id, draft_id, owner_subject, text, visibility, version, checksum, state, created_at, updated_at
          ) values (
            '${latestPostId}', '${source.post.draftId}', '${source.post.ownerSubject}',
            'Foreign latest media',
            'PUBLIC', 2, 'foreign-latest', 'draft',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          )
        `);
        await queryTestDatabase(db, `
          insert into career_mcp.post_draft_media (
            post_draft_id, version, position, media_id, alt_text
          ) values (
            '${latestPostId}', 2, 0, '${foreignLatestMedia.id}', 'Foreign latest'
          )
        `);
      }

      const error = await db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, finalMedia.id, {
          expectedDraftId,
          expectedVersion: 1
        })
      ).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      return {
        code: domainError.code,
        message: domainError.message,
        details: domainError.details
      };
    };

    const failures = [];
    for (const lineage of [
      "foreign_exact",
      "unattached_exact",
      "absent_exact",
      "foreign_latest"
    ] as const) {
      failures.push(await rejection(lineage));
    }

    expect(new Set(failures.map((failure) => JSON.stringify(failure))).size).toBe(1);
    expect(failures[0]).toEqual({
      code: "NOT_FOUND",
      message: "Brand visual brief source was not found",
      details: { entity: "post_draft" }
    });
  });

  it("blocks raw brief-source reassignment and direct claim mutation", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner);
    const replacement = await addOwnedPost(owner);

    await expect(queryTestDatabase(db, `
      update career_mcp.brand_visual_briefs
      set post_draft_id = '${replacement.id}', post_version = ${replacement.version}
      where id = '${source.brief.id}'
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_brief_source_immutable"
    });
    await expect(queryTestDatabase(db, `
      update career_mcp.brand_brief_source_claims
      set owner_subject = '${randomUUID()}'
      where brief_id = '${source.brief.id}'
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_brief_source_claim_immutable"
    });
    await expect(queryTestDatabase(db, `
      delete from career_mcp.brand_brief_source_claims
      where brief_id = '${source.brief.id}'
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_brief_source_claim_immutable"
    });

    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({
        postDraftId: source.post.id,
        postVersion: source.post.version,
        state: "ready"
      });
  });

  it("rejects a raw brief that claims another owner for an owned text-only post", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const source = await readyBrandedRender(owner);
    const forgedBriefId = randomUUID();

    await expect(queryTestDatabase(db, `
      insert into career_mcp.brand_visual_briefs (
        id, owner_subject, post_draft_id, post_version, brand_profile_id,
        brand_profile_version, template_id, template_version, prompt_format_version,
        visual_mode, cover_hook, concept_summary, topic_label, generation_prompt,
        negative_constraints_json, state, created_at
      ) values (
        '${forgedBriefId}', '${otherOwner}', '${source.post.id}', ${source.post.version},
        '${source.brief.brandProfileId}', ${source.brief.brandProfileVersion},
        'editorial-statement-v1', 1, 1, 'EDITORIAL_STATEMENT',
        'Forged owner hook', 'Forged owner concept', null, 'Forged owner prompt',
        '[]'::jsonb, 'ready', now()
      )
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_brief_source_owner_mismatch"
    });

    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.brand_brief_source_claims
      where brief_id = '${forgedBriefId}'
    `)).toEqual([{ count: 0 }]);
  });

  it("keeps every logical draft version bound to its first owner", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const first = await db.postDrafts.createVersionWithMedia({
      ownerSubject: owner,
      text: "Owner-bound text draft",
      visibility: "PUBLIC",
      checksum: "owner-bound-v1",
      state: "draft",
      media: []
    });

    await expect(db.postDrafts.createVersionWithMedia({
      draftId: first.post.draftId,
      expectedVersion: first.post.version,
      ownerSubject: otherOwner,
      text: "Cross-owner version",
      visibility: "PUBLIC",
      checksum: "owner-bound-v2",
      state: "draft",
      media: []
    })).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "post_draft_owner_immutable"
      }
    });

    expect(await queryTestDatabase(db, `
      select draft_id, owner_subject
      from career_mcp.post_draft_owners
      where draft_id = '${first.post.draftId}'
    `)).toEqual([{
      draft_id: first.post.draftId,
      owner_subject: owner
    }]);
    expect(await db.postDrafts.listVersions(first.post.draftId)).toHaveLength(1);
  });

  it.each([
    ["foreign final media", "final", "NOT_FOUND"],
    ["foreign source media", "source", "NOT_FOUND"],
    ["render checksum mismatch", "checksum", "DATA_INTEGRITY"],
    ["source reused as final", "same", "DATA_INTEGRITY"]
  ] as const)(
    "branded render rejects %s without changing the brief or post history",
    async (_label, mutation, code) => {
      const owner = randomUUID();
      const source = await readyBrandedRender(owner, {
        visualMode: "EDITORIAL_METAPHOR"
      });
      const sourceMedia = await addMedia({
        ownerSubject: mutation === "source" ? randomUUID() : owner,
        sha256: "b".repeat(64)
      });
      const finalMedia = mutation === "same"
        ? sourceMedia
        : await addMedia({
            ownerSubject: mutation === "final" ? randomUUID() : owner,
            sha256: "a".repeat(64),
            width: 1080,
            height: 1350
          });
      const input = brandedRenderInput(owner, source, finalMedia.id, {
        sourceMediaId: mutation === "same" ? finalMedia.id : sourceMedia.id,
        ...(mutation === "checksum" ? { renderChecksum: "c".repeat(64) } : {})
      });

      await expect(db.brandVisualRenders.commitAndAttach(input))
        .rejects.toMatchObject({ code });

      expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(1);
      expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
        .toMatchObject({ state: "ready" });
      expect(await queryTestDatabase<{ count: number }>(db, `
        select count(*)::int as count from career_mcp.brand_visual_renders
      `)).toEqual([{ count: 0 }]);
    }
  );

  it("branded render rejects a source-art row that is already attached to a post", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const [alreadyAttached] = await db.postDraftMedia.listForVersion(
      source.post.id,
      source.post.version
    );
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });

    await expect(db.brandVisualRenders.commitAndAttach(
      brandedRenderInput(owner, source, finalMedia.id, {
        sourceMediaId: alreadyAttached?.mediaId
      })
    )).rejects.toMatchObject({ code: "DATA_INTEGRITY" });

    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(1);
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "ready" });
  });

  it("repository attachment paths reject media already reserved as render source with a safe error", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const sourceMedia = await addMedia({
      ownerSubject: owner,
      sha256: "b".repeat(64)
    });
    const renderedMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${owner}', '${source.brief.id}', 1, '${sourceMedia.id}',
        '${renderedMedia.id}', 'Reserved source', '${renderedMedia.sha256}', 1,
        '2026-07-23T00:00:00.000Z'
      )
    `);

    await expect(db.postDrafts.createVersionWithMedia({
      ownerSubject: owner,
      text: "Must not attach reserved source art",
      visibility: "PUBLIC",
      checksum: "reserved-source-attachment",
      state: "draft",
      media: [{ mediaId: sourceMedia.id, altText: "Reserved source art" }]
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand render data is invalid",
      details: { entity: "brand_visual_render" }
    });
  });

  it("repository paths safely reject conservative opposite-purpose claims after role rows are removed", async () => {
    const sourceOwner = randomUUID();
    const source = await readyBrandedRender(sourceOwner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const formerlyAttached = await addMedia({
      ownerSubject: sourceOwner,
      sha256: "b".repeat(64)
    });
    const temporaryAttachment = await db.postDrafts.createVersionWithMedia({
      ownerSubject: sourceOwner,
      text: "Temporary attachment claim",
      visibility: "PUBLIC",
      checksum: "temporary-attachment-claim",
      state: "draft",
      media: [{ mediaId: formerlyAttached.id, altText: "Temporary attachment" }]
    });
    await queryTestDatabase(db, `
      delete from career_mcp.post_draft_media
      where post_draft_id = '${temporaryAttachment.post.id}'
        and version = ${temporaryAttachment.post.version}
    `);
    const finalMedia = await addMedia({
      ownerSubject: sourceOwner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    await expect(db.brandVisualRenders.commitAndAttach(
      brandedRenderInput(sourceOwner, source, finalMedia.id, {
        sourceMediaId: formerlyAttached.id
      })
    )).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand render data is invalid",
      details: { entity: "brand_visual_render" }
    });

    const attachmentOwner = randomUUID();
    const reserved = await readyBrandedRender(attachmentOwner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const formerlySource = await addMedia({
      ownerSubject: attachmentOwner,
      sha256: "c".repeat(64)
    });
    const rendered = await addMedia({
      ownerSubject: attachmentOwner,
      sha256: "d".repeat(64),
      width: 1080,
      height: 1350
    });
    const renderId = randomUUID();
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${renderId}', '${attachmentOwner}', '${reserved.brief.id}', 1,
        '${formerlySource.id}', '${rendered.id}', 'Persistent source claim',
        '${rendered.sha256}', 1, '2026-07-23T00:00:00.000Z'
      )
    `);
    await queryTestDatabase(db, `
      delete from career_mcp.brand_visual_renders
      where id = '${renderId}'
    `);
    await expect(db.postDrafts.createVersionWithMedia({
      ownerSubject: attachmentOwner,
      text: "Must respect persistent source claim",
      visibility: "PUBLIC",
      checksum: "persistent-source-claim",
      state: "draft",
      media: [{ mediaId: formerlySource.id, altText: "Persistent source" }]
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand render data is invalid",
      details: { entity: "brand_visual_render" }
    });
  });

  it("branded render rejects a final attachment already reserved as source with a safe error", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const source = await readyBrandedRender(owner);
    const foreign = await readyBrandedRender(otherOwner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const reservedFinal = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    const foreignRendered = await addMedia({
      ownerSubject: otherOwner,
      sha256: "b".repeat(64),
      width: 1080,
      height: 1350
    });
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${otherOwner}', '${foreign.brief.id}', 1,
        '${reservedFinal.id}', '${foreignRendered.id}', 'Reserved source',
        '${foreignRendered.sha256}', 1, '2026-07-23T00:00:00.000Z'
      )
    `);

    await expect(db.brandVisualRenders.commitAndAttach(
      brandedRenderInput(owner, source, reservedFinal.id, {
        renderChecksum: reservedFinal.sha256
      })
    )).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand render data is invalid",
      details: { entity: "brand_visual_render" }
    });
    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(1);
  });

  it("database triggers reject source registration and post attachment in either sequential order", async () => {
    const firstOwner = randomUUID();
    const first = await readyBrandedRender(firstOwner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const reservedSource = await addMedia({
      ownerSubject: firstOwner,
      sha256: "b".repeat(64)
    });
    const firstRendered = await addMedia({
      ownerSubject: firstOwner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${firstOwner}', '${first.brief.id}', 1,
        '${reservedSource.id}', '${firstRendered.id}', 'Reserved source',
        '${firstRendered.sha256}', 1, '2026-07-23T00:00:00.000Z'
      )
    `);
    expect(await queryTestDatabase(db, `
      select media_id, owner_subject, purpose
      from career_mcp.media_usage_claims
      where media_id = '${reservedSource.id}'
    `)).toEqual([{
      media_id: reservedSource.id,
      owner_subject: firstOwner,
      purpose: "brand_source"
    }]);
    const attachTarget = await db.postDrafts.createVersion({
      ownerSubject: firstOwner,
      text: "Direct attachment target",
      visibility: "PUBLIC",
      checksum: "direct-attachment-target",
      state: "draft"
    });
    await expect(queryTestDatabase(db, `
      insert into career_mcp.post_draft_media (
        post_draft_id, version, position, media_id, alt_text
      ) values (
        '${attachTarget.id}', ${attachTarget.version}, 0, '${reservedSource.id}',
        'Must be rejected'
      )
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_source_media_exclusive"
    });

    const secondOwner = randomUUID();
    const second = await readyBrandedRender(secondOwner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const [attachedSource] = await db.postDraftMedia.listForVersion(
      second.post.id,
      second.post.version
    );
    expect(await queryTestDatabase(db, `
      select media_id, owner_subject, purpose
      from career_mcp.media_usage_claims
      where media_id = '${attachedSource!.mediaId}'
    `)).toEqual([{
      media_id: attachedSource!.mediaId,
      owner_subject: secondOwner,
      purpose: "attached"
    }]);
    const secondRendered = await addMedia({
      ownerSubject: secondOwner,
      sha256: "c".repeat(64),
      width: 1080,
      height: 1350
    });
    await expect(queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${secondOwner}', '${second.brief.id}', 1,
        '${attachedSource!.mediaId}', '${secondRendered.id}', 'Attached source',
        '${secondRendered.sha256}', 1, '2026-07-23T00:00:00.000Z'
      )
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_source_media_exclusive"
    });
  });

  it("allows repeated same-purpose attachments while retaining one claim row", async () => {
    const owner = randomUUID();
    const media = await addMedia({ ownerSubject: owner });
    const first = await db.postDrafts.createVersionWithMedia({
      ownerSubject: owner,
      text: "First same-purpose claim",
      visibility: "PUBLIC",
      checksum: "first-same-purpose-claim",
      state: "draft",
      media: [{ mediaId: media.id, altText: "Shared attachment" }]
    });
    await db.postDrafts.createVersionWithMedia({
      draftId: first.post.draftId,
      ownerSubject: owner,
      text: "Second same-purpose claim",
      visibility: "PUBLIC",
      checksum: "second-same-purpose-claim",
      state: "draft",
      media: [{ mediaId: media.id, altText: "Shared attachment" }]
    });

    expect(await queryTestDatabase(db, `
      select media_id, owner_subject, purpose, count(*)::int as count
      from career_mcp.media_usage_claims
      where media_id = '${media.id}'
      group by media_id, owner_subject, purpose
    `)).toEqual([{
      media_id: media.id,
      owner_subject: owner,
      purpose: "attached",
      count: 1
    }]);
  });

  it("database triggers enforce source-media exclusivity on both update paths", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner);
    const [attached] = await db.postDraftMedia.listForVersion(
      source.post.id,
      source.post.version
    );
    const reservedSource = await addMedia({
      ownerSubject: owner,
      sha256: "b".repeat(64)
    });
    const rendered = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    const renderId = randomUUID();
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
        alt_text, render_checksum, renderer_version, created_at
      ) values (
        '${renderId}', '${owner}', '${source.brief.id}', 1, '${reservedSource.id}',
        '${rendered.id}', 'Reserved source', '${rendered.sha256}', 1,
        '2026-07-23T00:00:00.000Z'
      )
    `);

    await expect(queryTestDatabase(db, `
      update career_mcp.post_draft_media
      set media_id = '${reservedSource.id}'
      where post_draft_id = '${source.post.id}'
        and version = ${source.post.version}
        and position = 0
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_source_media_exclusive"
    });
    await expect(queryTestDatabase(db, `
      update career_mcp.brand_visual_renders
      set source_media_id = '${attached!.mediaId}'
      where id = '${renderId}'
    `)).rejects.toMatchObject({
      code: "23514",
      constraint: "brand_source_media_exclusive"
    });
  });

  it("local concurrent attachment and source registration allow exactly one media role", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner, {
      visualMode: "EDITORIAL_METAPHOR"
    });
    const racedMedia = await addMedia({
      ownerSubject: owner,
      sha256: "b".repeat(64)
    });
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });

    const results = await Promise.allSettled([
      db.postDrafts.createVersionWithMedia({
        ownerSubject: owner,
        text: "Concurrent source attachment",
        visibility: "PUBLIC",
        checksum: "concurrent-source-attachment",
        state: "draft",
        media: [{ mediaId: racedMedia.id, altText: "Concurrent source" }]
      }),
      db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, finalMedia.id, {
          sourceMediaId: racedMedia.id
        })
      )
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "DATA_INTEGRITY",
          details: { entity: "brand_visual_render" }
        })
      })
    ]);
    const [counts] = await queryTestDatabase<{
      attachments: number;
      renders: number;
    }>(db, `
      select
        (
          select count(*)::int
          from career_mcp.post_draft_media
          where media_id = '${racedMedia.id}'
        ) as attachments,
        (
          select count(*)::int
          from career_mcp.brand_visual_renders
          where source_media_id = '${racedMedia.id}'
        ) as renders
    `);
    expect((counts?.attachments ?? 0) + (counts?.renders ?? 0)).toBe(1);
  });

  it("branded render allows only one concurrent ready-to-render commit", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner);
    const firstFinal = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    const secondFinal = await addMedia({
      ownerSubject: owner,
      sha256: "b".repeat(64),
      width: 1080,
      height: 1350
    });

    const results = await Promise.allSettled([
      db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, firstFinal.id, {
          renderChecksum: firstFinal.sha256
        })
      ),
      db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, secondFinal.id, {
          renderChecksum: secondFinal.sha256
        })
      )
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "CONFLICT" })
      })
    ]);
    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(2);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.brand_visual_renders
    `)).toEqual([{ count: 1 }]);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.post_draft_media
      where post_draft_id <> '${source.post.id}'
    `)).toEqual([{ count: 1 }]);
  });

  it("branded render rolls back the post and attachment when the provenance insert fails", async () => {
    const owner = randomUUID();
    const source = await readyBrandedRender(owner);
    const finalMedia = await addMedia({
      ownerSubject: owner,
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350
    });
    await queryTestDatabase(db, `
      alter table career_mcp.brand_visual_renders
      add constraint task_7_forced_render_failure check (false)
    `);

    try {
      await expect(db.brandVisualRenders.commitAndAttach(
        brandedRenderInput(owner, source, finalMedia.id)
      )).rejects.toBeDefined();
    } finally {
      await queryTestDatabase(db, `
        alter table career_mcp.brand_visual_renders
        drop constraint task_7_forced_render_failure
      `);
    }

    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(1);
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "ready" });
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.post_draft_media
      where post_draft_id <> '${source.post.id}'
    `)).toEqual([{ count: 0 }]);
  });
});

describe("exact preview snapshot locking", () => {
  it("locks draft-media rows first and shared media rows in global UUID order", async () => {
    const ownerSubject = "123e4567-e89b-12d3-a456-426614174000";
    const draftId = "223e4567-e89b-12d3-a456-426614174000";
    const lowerMediaId = "323e4567-e89b-12d3-a456-426614174000";
    const higherMediaId = "323e4567-e89b-12d3-a456-426614174001";
    for (const [id, digit] of [[lowerMediaId, "1"], [higherMediaId, "2"]] as const) {
      await db.postMedia.create({
        id,
        ownerSubject,
        objectPath: `${ownerSubject}/${digit}${digit}/${id}.png`,
        sha256: digit.repeat(64),
        mimeType: "image/png",
        byteSize: 100,
        width: 640,
        height: 480,
        frameCount: 1,
        originalFilename: `${id}.png`,
        createdAt: "2026-07-19T12:00:00.000Z"
      });
    }
    const text = "Reverse display order";
    const visibility = "CONNECTIONS";
    const created = await db.postDrafts.createVersionWithMedia({
      draftId,
      ownerSubject,
      text,
      visibility,
      state: "draft",
      media: [
        { mediaId: higherMediaId, altText: "Higher first" },
        { mediaId: lowerMediaId, altText: "Lower second" }
      ],
      checksum: (version, actualDraftId, media) => checksumLinkedInPost({
        draftId: actualDraftId,
        version,
        text,
        visibility,
        media: media.map((item) => ({
          ...item,
          mimeType: item.mimeType as "image/png"
        }))
      })
    });

    queryLog.length = 0;
    const result = await db.previews.createForLatest({
      draftId,
      version: created.post.version,
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-19T12:15:00.000Z",
      allowedStates: ["draft"],
      expectedVersionId: created.post.id,
      expectedChecksum: created.post.checksum,
      expectedSnapshot: {
        subject: ownerSubject,
        post: created.post,
        media: created.media
      }
    });

    expect(result.outcome).toBe("created");
    const lockQueries = queryLog.filter(({ query }) => /for update/i.test(query));
    const joinLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_draft_media"')
      && !query.includes('join "career_mcp"."post_media"')
    ));
    const mediaLockIndex = lockQueries.findIndex(({ query }) => (
      query.includes('from "career_mcp"."post_media"')
      && query.includes('order by "career_mcp"."post_media"."id" asc')
    ));
    expect(joinLockIndex).toBeGreaterThanOrEqual(0);
    expect(mediaLockIndex).toBeGreaterThan(joinLockIndex);
    expect(lockQueries[mediaLockIndex]?.params).toEqual([lowerMediaId, higherMediaId]);
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
    const [firstRefresh, secondRefresh] = await Promise.all([refresh(80), refresh(85)]);

    expect(firstRefresh.totalScore).toBe(80);
    expect(firstRefresh.pmmOpportunity).toBe(35);
    expect(secondRefresh.totalScore).toBe(85);
    expect(secondRefresh.pmmOpportunity).toBe(40);
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

it("durably reuses outreach request IDs and versions changed requests", async () => {
  const { person, target } = await addTarget("Idempotent outreach");
  const source = await db.evidence.add({
    personId: person.id,
    sourceUrl: "https://acme.example/idempotent-team",
    fact: "Founder",
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  });
  const input = {
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello Ada",
    evidenceIds: [source.id],
    requestId: "request-a",
    requestPayloadHash: "a".repeat(64)
  };

  const [first, duplicate] = await Promise.all([
    db.outreachDrafts.createOrReuseVersion(input),
    db.outreachDrafts.createOrReuseVersion({ ...input, evidenceIds: [...input.evidenceIds] })
  ]);
  const changed = await db.outreachDrafts.createOrReuseVersion({
    ...input,
    requestId: "request-b",
    requestPayloadHash: "b".repeat(64),
    text: "Hello Ada — revised"
  });
  const retriedFirst = await db.outreachDrafts.createOrReuseVersion(input);

  expect(duplicate).toEqual(first);
  expect(first.version).toBe(1);
  expect(changed.version).toBe(2);
  expect(retriedFirst).toEqual(first);
  expect(first.requestId).toBe("request-a");
  expect(first.requestPayloadHash).toBe("a".repeat(64));
  await expect(db.outreachDrafts.createOrReuseVersion({
    ...input,
    requestPayloadHash: "c".repeat(64),
    text: "Hello Ada — conflicting retry"
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await db.outreachDrafts.listForTarget(target.id)).toHaveLength(2);
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
    ownerSubject: DEFAULT_POST_OWNER,
    text: "First",
    visibility: "PUBLIC",
    checksum: "checksum-1",
    state: "draft"
  }));
  const second = (await db.postDrafts.createVersion({
    draftId: first.draftId,
    ownerSubject: DEFAULT_POST_OWNER,
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

it("deduplicates media SHA values within an owner while allowing the same bytes for another owner", async () => {
  const owner = randomUUID();
  const otherOwner = randomUUID();
  const sha = "a".repeat(64);
  const media = await addMedia({ ownerSubject: owner, sha256: sha, originalFilename: "hero.png" });
  const otherMedia = await addMedia({ ownerSubject: otherOwner, sha256: sha });

  expect(await db.postMedia.get(media.id)).toEqual(media);
  expect(await db.postMedia.getByOwnerAndSha(owner, sha)).toMatchObject({
    ownerSubject: owner,
    sha256: sha
  });
  expect(await db.postMedia.getByOwnerAndSha(otherOwner, sha)).toMatchObject({
    id: otherMedia.id,
    ownerSubject: otherOwner
  });
  const duplicateError = await addMedia({ ownerSubject: owner, sha256: sha }).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(postgresErrorKind(duplicateError)).toBe("unique");
});

it("preserves immutable four-image ordering across exact post versions", async () => {
  const ownerSubject = randomUUID();
  const storedMedia = await Promise.all(Array.from({ length: 4 }, async (_, index) => (
    addMedia({
      ownerSubject,
      sha256: index.toString(16).padStart(64, "0")
    })
  )));
  const first = await db.postDrafts.createVersionWithMedia({
    ownerSubject,
    text: "Four ordered images",
    visibility: "PUBLIC",
    checksum: "ordered-v1",
    state: "ready_for_review",
    media: storedMedia.map((media, index) => ({
      mediaId: media.id,
      altText: `Image ${index + 1}`
    }))
  });
  const reversed = [...storedMedia].reverse();
  const second = await db.postDrafts.createVersionWithMedia({
    draftId: first.post.draftId,
    ownerSubject,
    text: "Four ordered images, reversed",
    visibility: "PUBLIC",
    checksum: "ordered-v2",
    state: "ready_for_review",
    media: reversed.map((media, index) => ({
      mediaId: media.id,
      altText: `Reversed image ${index + 1}`
    }))
  });

  expect(first.media.map(({ position, mediaId }) => ({ position, mediaId }))).toEqual(
    storedMedia.map((media, position) => ({ position, mediaId: media.id }))
  );
  expect(await db.postDraftMedia.listForVersion(second.post.id, 2)).toHaveLength(4);
  expect((await db.postDraftMedia.listForVersion(second.post.id, 2)).map((row) => row.mediaId)).toEqual(
    reversed.map((media) => media.id)
  );
  expect((await db.postDraftMedia.listForVersion(first.post.id, 1)).map((row) => row.mediaId)).toEqual(
    storedMedia.map((media) => media.id)
  );
});

it("rolls back media draft creation when any media belongs to another owner", async () => {
  const ownerSubject = randomUUID();
  const allowed = await addMedia({ ownerSubject });
  const forbidden = await addMedia({ ownerSubject: randomUUID() });
  const draftId = randomUUID();

  await expect(db.postDrafts.createVersionWithMedia({
    draftId,
    ownerSubject,
    text: "Owner mismatch",
    visibility: "PUBLIC",
    checksum: "owner-mismatch",
    state: "draft",
    media: [
      { mediaId: allowed.id, altText: "Allowed" },
      { mediaId: forbidden.id, altText: "Forbidden" }
    ]
  })).rejects.toThrow(/owned by the request subject/i);

  expect(await db.postDrafts.listVersions(draftId)).toEqual([]);
});

it.each([0, 1])(
  "allocates concurrent post versions and checksums from a sequence containing %i rows",
  async (existingVersionCount) => {
    const draftId = randomUUID();
    if (existingVersionCount === 1) {
      await db.postDrafts.createVersion({
        draftId,
        ownerSubject: DEFAULT_POST_OWNER,
        text: "Existing",
        visibility: "PUBLIC",
        checksum: (version) => computePostChecksum("Existing", version),
        state: "draft"
      });
    }

    const created = await Promise.all(["Concurrent A", "Concurrent B"].map(async (text) => (
      db.postDrafts.createVersion({
        draftId,
        ownerSubject: DEFAULT_POST_OWNER,
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
    ownerSubject: DEFAULT_POST_OWNER,
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
    ownerSubject: DEFAULT_POST_OWNER,
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
    ownerSubject: DEFAULT_POST_OWNER,
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

it("lists ordered publish-attempt media and conditionally advances durable upload state", async () => {
  const ownerSubject = randomUUID();
  const media = await Promise.all([
    addMedia({ ownerSubject, sha256: "b".repeat(64) }),
    addMedia({ ownerSubject, sha256: "c".repeat(64) })
  ]);
  const post = await db.postDrafts.createVersionWithMedia({
    ownerSubject,
    text: "Publish with images",
    visibility: "PUBLIC",
    checksum: "publish-images",
    state: "uploading_media",
    media: media.map((item, index) => ({ mediaId: item.id, altText: `Media ${index + 1}` }))
  });
  const attempt = await db.publishAttempts.record({
    postDraftId: post.post.id,
    version: post.post.version,
    requestedAt: "2026-07-16T00:00:00.000Z",
    responseCategory: "pending",
    phase: "uploading_media",
    mediaCount: 2
  });
  const attemptMediaIds = [randomUUID(), randomUUID()] as const;
  await queryTestDatabase(db, `
    insert into career_mcp.publish_attempt_media (
      id, publish_attempt_id, media_id, position, state
    ) values
      ('${attemptMediaIds[1]}', '${attempt.id}', '${media[1].id}', 1, 'pending'),
      ('${attemptMediaIds[0]}', '${attempt.id}', '${media[0].id}', 0, 'pending')
  `);

  expect((await db.publishAttemptMedia.listForAttempt(attempt.id)).map((row) => row.position)).toEqual([0, 1]);
  const initialized = await db.publishAttemptMedia.updateState({
    id: attemptMediaIds[0],
    expectedState: "pending",
    state: "initialized",
    linkedinImageUrn: "urn:li:image:123"
  });
  expect(initialized).toMatchObject({
    id: attemptMediaIds[0],
    state: "initialized",
    linkedinImageUrn: "urn:li:image:123"
  });
  expect(await db.publishAttemptMedia.updateState({
    id: attemptMediaIds[0],
    expectedState: "pending",
    state: "uploaded"
  })).toBeUndefined();
});

it("rolls back a publish claim whose attempt names a different exact post version", async () => {
  const claimedPost = await db.postDrafts.createVersion({
    ownerSubject: DEFAULT_POST_OWNER,
    text: "Claim this post",
    visibility: "PUBLIC",
    checksum: "claimed-checksum",
    state: "draft"
  });
  const differentPost = await db.postDrafts.createVersion({
    ownerSubject: DEFAULT_POST_OWNER,
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
    ownerSubject: DEFAULT_POST_OWNER,
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
