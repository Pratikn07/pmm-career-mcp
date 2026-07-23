import { randomUUID } from "node:crypto";
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
    width: 1200,
    height: 627,
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
  it("migrates exactly the nineteen application tables into the private schema", async () => {
    const tables = await queryTestDatabase<{ table_name: string }>(db, `
      select table_name
      from information_schema.tables
      where table_schema = 'career_mcp'
        and table_type = 'BASE TABLE'
      order by table_name
    `);

    expect(tables.map((row) => row.table_name)).toEqual([
      "brand_profiles",
      "brand_visual_briefs",
      "brand_visual_renders",
      "companies",
      "evidence",
      "oauth_tokens",
      "outreach_drafts",
      "people",
      "post_draft_media",
      "post_drafts",
      "post_media",
      "post_previews",
      "publish_attempt_media",
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
        and column_name not in ('yc_id', 'template_id')
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
          'brand_profiles', 'brand_visual_briefs', 'brand_visual_renders',
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
