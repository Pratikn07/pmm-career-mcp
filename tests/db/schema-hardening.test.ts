import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

let db: TestCareerDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.resetForTests();
});

afterAll(async () => {
  await db?.close();
});

async function seedConstraintGraph() {
  const company = await db.companies.upsert({
    ycId: `constraint-company-${randomUUID()}`,
    name: "Constraint Company"
  });
  const person = await db.people.upsert({
    companyId: company.id,
    name: "Constraint Person",
    role: "Founder"
  });
  const evidence = await db.evidence.add({
    personId: person.id,
    sourceUrl: "https://example.com/team",
    fact: "Founder",
    checkedAt: "2026-07-18T00:00:00.000Z",
    confidence: 0.9
  });
  const target = await db.targets.upsert({
    personId: person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    totalScore: 75,
    confidence: 0.9,
    rationale: "Constraint test target"
  });
  const outreach = await db.outreachDrafts.createVersion({
    targetId: target.id,
    purpose: "connection_note",
    text: "Hello",
    evidenceIds: [evidence.id]
  });
  const shortlist = await db.shortlists.create({
    name: "Constraint shortlist",
    targetIds: [target.id]
  });
  const [shortlistEntry] = (await db.shortlists.getWithEntries(shortlist.id))?.entries ?? [];
  if (shortlistEntry === undefined) {
    throw new Error("Expected seeded shortlist entry");
  }
  const post = await db.postDrafts.createVersion({
    text: "Constraint post",
    visibility: "PUBLIC",
    checksum: "constraint-checksum",
    state: "draft"
  });
  const preview = await db.previews.create({
    postDraftId: post.id,
    version: post.version,
    tokenHash: `constraint-preview-${randomUUID()}`,
    expiresAt: "2026-07-18T00:15:00.000Z"
  });
  const attempt = await db.publishAttempts.record({
    postDraftId: post.id,
    version: post.version,
    requestedAt: "2026-07-18T00:00:00.000Z",
    responseCategory: "pending"
  });

  return {
    company,
    person,
    evidence,
    target,
    outreach,
    shortlistEntry,
    post,
    preview,
    attempt
  };
}

async function expectCheckViolation(statement: string): Promise<void> {
  await expect(queryTestDatabase(db, statement)).rejects.toMatchObject({ code: "23514" });
}

describe("foreign-key indexing", () => {
  it("gives every foreign key a valid non-partial index with the complete key as its leading columns", async () => {
    const missing = await queryTestDatabase<{
      table_name: string;
      constraint_name: string;
      columns: string;
    }>(db, `
      select
        constraint_row.conrelid::regclass::text as table_name,
        constraint_row.conname as constraint_name,
        (
          select string_agg(attribute.attname, ',' order by key_column.ordinality)
          from unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
          join pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid
           and attribute.attnum = key_column.attnum
        ) as columns
      from pg_constraint constraint_row
      where constraint_row.contype = 'f'
        and constraint_row.connamespace = 'career_mcp'::regnamespace
        and not exists (
          select 1
          from pg_index index_row
          where index_row.indrelid = constraint_row.conrelid
            and index_row.indisvalid
            and index_row.indisready
            and index_row.indpred is null
            and index_row.indexprs is null
            and not exists (
              select 1
              from generate_subscripts(constraint_row.conkey, 1) as key_position(position)
              where index_row.indkey[key_position.position - 1]
                is distinct from constraint_row.conkey[key_position.position]
            )
        )
      order by table_name, constraint_name
    `);

    expect(missing).toEqual([]);
  });

  it("uses only the exact-version composite foreign keys for preview and publish rows", async () => {
    const foreignKeys = await queryTestDatabase<{
      table_name: string;
      constraint_name: string;
      columns: string;
    }>(db, `
      select
        constraint_row.conrelid::regclass::text as table_name,
        constraint_row.conname as constraint_name,
        string_agg(attribute.attname, ',' order by key_column.ordinality) as columns
      from pg_constraint constraint_row
      cross join lateral unnest(constraint_row.conkey)
        with ordinality as key_column(attnum, ordinality)
      join pg_attribute attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
      where constraint_row.contype = 'f'
        and constraint_row.connamespace = 'career_mcp'::regnamespace
        and constraint_row.conrelid in (
          'career_mcp.post_previews'::regclass,
          'career_mcp.publish_attempts'::regclass
        )
      group by constraint_row.conrelid, constraint_row.conname
      order by table_name, constraint_name
    `);

    expect(foreignKeys).toEqual([
      {
        table_name: "career_mcp.post_previews",
        constraint_name: "post_previews_exact_version_fk",
        columns: "post_draft_id,version"
      },
      {
        table_name: "career_mcp.publish_attempts",
        constraint_name: "publish_attempts_exact_version_fk",
        columns: "post_draft_id,version"
      }
    ]);
  });
});

describe("database domain constraints", () => {
  it.each([-0.01, 1.01])("rejects evidence confidence %s outside 0..1", async (confidence) => {
    const { person } = await seedConstraintGraph();
    await expectCheckViolation(`
      insert into career_mcp.evidence (
        id, person_id, source_url, fact, checked_at, confidence, created_at
      ) values (
        '${randomUUID()}',
        '${person.id}',
        'https://example.com/invalid-confidence',
        'Invalid confidence',
        '2026-07-18T00:00:00.000Z',
        ${confidence},
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it.each([
    ["pmm_opportunity", -0.01],
    ["pmm_opportunity", 100.01],
    ["referral_potential", -0.01],
    ["referral_potential", 100.01],
    ["network_value", -0.01],
    ["network_value", 100.01],
    ["total_score", -0.01],
    ["total_score", 100.01],
    ["confidence", -0.01],
    ["confidence", 1.01]
  ])("rejects target %s value %s outside its domain", async (column, value) => {
    const { company } = await seedConstraintGraph();
    const person = await db.people.upsert({
      companyId: company.id,
      name: `Invalid ${column} ${value}`,
      role: "Founder"
    });
    const score = {
      pmm_opportunity: 30,
      referral_potential: 25,
      network_value: 20,
      total_score: 75,
      confidence: 0.9,
      [column]: value
    };
    await expectCheckViolation(`
      insert into career_mcp.targets (
        id,
        person_id,
        pmm_opportunity,
        referral_potential,
        network_value,
        total_score,
        confidence,
        status,
        rationale,
        created_at,
        updated_at
      ) values (
        '${randomUUID()}',
        '${person.id}',
        ${score.pmm_opportunity},
        ${score.referral_potential},
        ${score.network_value},
        ${score.total_score},
        ${score.confidence},
        'discovered',
        'Invalid score domain',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects a target pipeline status outside the fixed state machine", async () => {
    const { company } = await seedConstraintGraph();
    const person = await db.people.upsert({
      companyId: company.id,
      name: "Invalid pipeline status",
      role: "Founder"
    });
    await expectCheckViolation(`
      insert into career_mcp.targets (
        id,
        person_id,
        pmm_opportunity,
        referral_potential,
        network_value,
        total_score,
        confidence,
        status,
        rationale,
        created_at,
        updated_at
      ) values (
        '${randomUUID()}',
        '${person.id}',
        30,
        25,
        20,
        75,
        0.9,
        'invented_status',
        'Invalid pipeline status',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects outreach versions below one", async () => {
    const { target } = await seedConstraintGraph();
    await expectCheckViolation(`
      insert into career_mcp.outreach_drafts (
        id, target_id, purpose, text, version, evidence_ids_json, created_at, updated_at
      ) values (
        '${randomUUID()}',
        '${target.id}',
        'connection_note',
        'Invalid version',
        0,
        '[]'::jsonb,
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects shortlist positions below zero", async () => {
    const { target } = await seedConstraintGraph();
    const shortlist = await db.shortlists.create({
      name: "Invalid position shortlist",
      targetIds: []
    });
    await expectCheckViolation(`
      insert into career_mcp.shortlist_entries (
        id, shortlist_id, target_id, position, created_at
      ) values (
        '${randomUUID()}',
        '${shortlist.id}',
        '${target.id}',
        -1,
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects post versions below one", async () => {
    await expectCheckViolation(`
      insert into career_mcp.post_drafts (
        id, draft_id, text, visibility, version, checksum, state, created_at, updated_at
      ) values (
        '${randomUUID()}',
        '${randomUUID()}',
        'Invalid version',
        'PUBLIC',
        0,
        'invalid-version-checksum',
        'draft',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects a post visibility outside the LinkedIn visibility domain", async () => {
    await expectCheckViolation(`
      insert into career_mcp.post_drafts (
        id, draft_id, text, visibility, version, checksum, state, created_at, updated_at
      ) values (
        '${randomUUID()}',
        '${randomUUID()}',
        'Invalid visibility',
        'PRIVATE',
        1,
        'invalid-visibility-checksum',
        'draft',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects a post state outside the publishing state machine", async () => {
    await expectCheckViolation(`
      insert into career_mcp.post_drafts (
        id, draft_id, text, visibility, version, checksum, state, created_at, updated_at
      ) values (
        '${randomUUID()}',
        '${randomUUID()}',
        'Invalid state',
        'PUBLIC',
        1,
        'invalid-state-checksum',
        'deleted',
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      )
    `);
  });

  it("rejects an unknown publish response category", async () => {
    const { post } = await seedConstraintGraph();
    await expectCheckViolation(`
      insert into career_mcp.publish_attempts (
        id, post_draft_id, version, requested_at, response_category
      ) values (
        '${randomUUID()}',
        '${post.id}',
        ${post.version},
        '2026-07-18T00:00:00.000Z',
        'unknown_category'
      )
    `);
  });

  it("accepts boundary values and every state used by current application flows", async () => {
    const { evidence, target, outreach, shortlistEntry, post, preview, attempt } = await seedConstraintGraph();

    for (const statement of [
      `update career_mcp.evidence set confidence = 0 where id = '${evidence.id}'`,
      `update career_mcp.evidence set confidence = 1 where id = '${evidence.id}'`,
      `update career_mcp.targets
       set pmm_opportunity = 0,
           referral_potential = 100,
           network_value = 0,
           total_score = 100,
           confidence = 0
       where id = '${target.id}'`,
      `update career_mcp.targets set confidence = 1 where id = '${target.id}'`,
      `update career_mcp.outreach_drafts set version = 1 where id = '${outreach.id}'`,
      `update career_mcp.shortlist_entries set position = 0 where id = '${shortlistEntry.id}'`,
      `update career_mcp.post_drafts set version = 1 where id = '${post.id}'`,
      `update career_mcp.post_previews set version = 1 where id = '${preview.id}'`,
      `update career_mcp.publish_attempts set version = 1 where id = '${attempt.id}'`
    ]) {
      await queryTestDatabase(db, statement);
    }

    for (const status of [
      "discovered",
      "shortlisted",
      "connect_planned",
      "connected",
      "contacted",
      "replied",
      "archived"
    ]) {
      await queryTestDatabase(db, `
        update career_mcp.targets set status = '${status}' where id = '${target.id}'
      `);
    }

    for (const visibility of ["PUBLIC", "CONNECTIONS"]) {
      await queryTestDatabase(db, `
        update career_mcp.post_drafts set visibility = '${visibility}' where id = '${post.id}'
      `);
    }

    for (const state of [
      "draft",
      "ready_for_preview",
      "publishing",
      "published",
      "publish_failed",
      "publish_unknown"
    ]) {
      await queryTestDatabase(db, `
        update career_mcp.post_drafts set state = '${state}' where id = '${post.id}'
      `);
    }

    for (const responseCategory of [
      "pending",
      "published",
      "definite_rejection",
      "ambiguous"
    ]) {
      await queryTestDatabase(db, `
        update career_mcp.publish_attempts
        set response_category = '${responseCategory}'
        where id = '${attempt.id}'
      `);
    }

    const [stored] = await queryTestDatabase<{
      status: string;
      confidence: number;
      state: string;
      visibility: string;
      response_category: string;
    }>(db, `
      select
        target.status,
        target.confidence,
        post.state,
        post.visibility,
        attempt.response_category
      from career_mcp.targets target
      cross join career_mcp.post_drafts post
      cross join career_mcp.publish_attempts attempt
      where target.id = '${target.id}'
        and post.id = '${post.id}'
        and attempt.id = '${attempt.id}'
    `);

    expect(stored).toEqual({
      status: "archived",
      confidence: 1,
      state: "publish_unknown",
      visibility: "CONNECTIONS",
      response_category: "ambiguous"
    });
  });
});
