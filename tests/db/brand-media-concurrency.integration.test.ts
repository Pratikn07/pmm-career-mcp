import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../../src/db/repositories.js";
import { DomainError } from "../../src/domain/errors.js";
import { schema } from "../../src/db/schema.js";

export function task7LocalDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const databaseUrl = env.TASK7_POSTGRES_TEST_DATABASE_URL;
  if (
    databaseUrl === undefined
    || env.TASK7_POSTGRES_TEST_ACK !== "local-docker-only"
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(databaseUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || !new Set(["localhost", "127.0.0.1", "::1"]).has(hostname)
    ) {
      return undefined;
    }
    return databaseUrl;
  } catch {
    return undefined;
  }
}

const databaseUrl = task7LocalDatabaseUrl(process.env);
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

type Seed = Readonly<{
  owner: string;
  draftId: string;
  firstPostId: string;
  latestPostId: string;
  profileId: string;
  briefId: string;
  baseMediaId: string;
  sourceMediaId: string;
  renderedMediaId: string;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function postgresField(error: unknown, field: "code" | "constraint_name"): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const row = current as Record<string, unknown>;
    if (typeof row[field] === "string") return row[field];
    current = row.cause;
  }
  return undefined;
}

describe("Task 7 PostgreSQL integration safety gate", () => {
  const localUrl = "postgres://postgres:postgres@127.0.0.1:54322/career_mcp_test";

  it("requires both the local-Docker acknowledgement and a loopback hostname", () => {
    expect(task7LocalDatabaseUrl({
      TASK7_POSTGRES_TEST_DATABASE_URL: localUrl
    })).toBeUndefined();
    expect(task7LocalDatabaseUrl({
      TASK7_POSTGRES_TEST_DATABASE_URL: "postgres://user:secret@db.example.com:5432/production",
      TASK7_POSTGRES_TEST_ACK: "local-docker-only"
    })).toBeUndefined();
    expect(task7LocalDatabaseUrl({
      TASK7_POSTGRES_TEST_DATABASE_URL: localUrl,
      TASK7_POSTGRES_TEST_ACK: "local-docker-only"
    })).toBe(localUrl);
  });

  it("fails closed for malformed URLs and lookalike loopback hostnames", () => {
    expect(task7LocalDatabaseUrl({
      TASK7_POSTGRES_TEST_DATABASE_URL: "not a url",
      TASK7_POSTGRES_TEST_ACK: "local-docker-only"
    })).toBeUndefined();
    expect(task7LocalDatabaseUrl({
      TASK7_POSTGRES_TEST_DATABASE_URL: "postgres://user:secret@localhost.example.com/db",
      TASK7_POSTGRES_TEST_ACK: "local-docker-only"
    })).toBeUndefined();
  });
});

async function createClients() {
  if (databaseUrl === undefined) {
    throw new Error("TASK7_POSTGRES_TEST_DATABASE_URL is required");
  }
  const options = {
    max: 1,
    prepare: false,
    idle_timeout: 2,
    connect_timeout: 5
  } as const;
  const attach = postgres(databaseUrl, options);
  const render = postgres(databaseUrl, options);
  const observer = postgres(databaseUrl, options);
  await Promise.all([
    attach`set statement_timeout = '3s'`,
    render`set statement_timeout = '3s'`,
    observer`set statement_timeout = '3s'`
  ]);
  return { attach, render, observer };
}

async function closeClients(clients: Awaited<ReturnType<typeof createClients>>): Promise<void> {
  await Promise.all([
    clients.attach.end({ timeout: 1 }),
    clients.render.end({ timeout: 1 }),
    clients.observer.end({ timeout: 1 })
  ]);
}

async function assertMigrationApplied(sql: Sql): Promise<void> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from pg_trigger
    where not tgisinternal
      and tgname in (
        'brand_source_media_exclusive_on_post_draft_media',
        'brand_source_media_exclusive_on_render'
      )
  `;
  expect(row?.count).toBe(2);
}

async function applyRuntimeRoleTemplate(sql: Sql): Promise<void> {
  const template = await readFile(resolve("supabase/runtime-role.sql"), "utf8");
  const postgresSql = template
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
  await sql.unsafe(postgresSql, [], { prepare: false });
}

async function asRuntimeError(
  sql: Sql,
  operation: (transaction: TransactionSql) => Promise<unknown>
): Promise<unknown> {
  return await sql.begin(async (transaction) => {
    await transaction`set local role career_mcp_runtime`;
    return await operation(transaction);
  }).then(
    () => undefined,
    (error: unknown) => error
  );
}

async function seed(sql: Sql, stale = false): Promise<Seed> {
  const result: Seed = {
    owner: randomUUID(),
    draftId: randomUUID(),
    firstPostId: randomUUID(),
    latestPostId: stale ? randomUUID() : "",
    profileId: randomUUID(),
    briefId: randomUUID(),
    baseMediaId: randomUUID(),
    sourceMediaId: randomUUID(),
    renderedMediaId: randomUUID()
  };
  const latestPostId = stale ? result.latestPostId : result.firstPostId;
  const firstChecksum = "1".repeat(64);
  const latestChecksum = "2".repeat(64);
  const sourceChecksum = "3".repeat(64);
  const renderedChecksum = "4".repeat(64);
  const baseChecksum = "5".repeat(64);

  await sql`
    insert into career_mcp.post_media (
      id, owner_subject, object_path, sha256, mime_type, byte_size,
      width, height, frame_count, original_filename, created_at
    ) values
      (
        ${result.baseMediaId}, ${result.owner},
        ${`${result.owner}/55/${result.baseMediaId}.png`}, ${baseChecksum},
        'image/png', 1024, 1200, 627, 1, 'post-source.png', now()
      ),
      (
        ${result.sourceMediaId}, ${result.owner},
        ${`${result.owner}/33/${result.sourceMediaId}.png`}, ${sourceChecksum},
        'image/png', 1024, 1200, 627, 1, 'source.png', now()
      ),
      (
        ${result.renderedMediaId}, ${result.owner},
        ${`${result.owner}/44/${result.renderedMediaId}.png`}, ${renderedChecksum},
        'image/png', 1024, 1080, 1350, 1, 'brand-cover.png', now()
      )
  `;
  await sql`
    insert into career_mcp.post_drafts (
      id, draft_id, text, visibility, version, checksum, state, created_at, updated_at
    ) values (
      ${result.firstPostId}, ${result.draftId}, 'Task 7 concurrency source',
      'PUBLIC', 1, ${firstChecksum}, 'draft', now(), now()
    )
  `;
  if (stale) {
    await sql`
      insert into career_mcp.post_drafts (
        id, draft_id, text, visibility, version, checksum, state, created_at, updated_at
      ) values (
        ${latestPostId}, ${result.draftId}, 'Task 7 newer immutable version',
        'PUBLIC', 2, ${latestChecksum}, 'draft', now(), now()
      )
    `;
  }
  await sql`
    insert into career_mcp.post_draft_media (
      post_draft_id, version, position, media_id, alt_text
    ) values (
      ${result.firstPostId}, 1, 0, ${result.baseMediaId}, 'Owned post source'
    )
  `;
  if (stale) {
    await sql`
      insert into career_mcp.post_draft_media (
        post_draft_id, version, position, media_id, alt_text
      ) values (
        ${latestPostId}, 2, 0, ${result.baseMediaId}, 'Owned latest post source'
      )
    `;
  }
  await sql`
    insert into career_mcp.brand_profiles (
      id, owner_subject, version, state, public_name, role_line, series_name,
      monogram, voice_json, palette_json, hook_rules_json, created_at
    ) values (
      ${result.profileId}, ${result.owner}, 1, 'active', 'Task 7 Test',
      'Product Marketing', 'PMM FIELD NOTES', 'T7', '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, now()
    )
  `;
  await sql`
    insert into career_mcp.brand_visual_briefs (
      id, owner_subject, post_draft_id, post_version, brand_profile_id,
      brand_profile_version, template_id, template_version, prompt_format_version,
      visual_mode, cover_hook, concept_summary, topic_label, generation_prompt,
      negative_constraints_json, state, created_at
    ) values (
      ${result.briefId}, ${result.owner}, ${result.firstPostId}, 1,
      ${result.profileId}, 1, ${stale ? "editorial-statement-v1" : "editorial-metaphor-v1"},
      1, 1, ${stale ? "EDITORIAL_STATEMENT" : "EDITORIAL_METAPHOR"},
      'Concurrency proof', 'Task 7 guarded integration', null,
      'A test-only visual', '[]'::jsonb, 'ready', now()
    )
  `;
  return { ...result, latestPostId };
}

async function cleanup(sql: Sql, seeded: Seed): Promise<void> {
  await sql`delete from career_mcp.brand_visual_renders where brief_id = ${seeded.briefId}`;
  await sql`
    delete from career_mcp.post_draft_media
    where post_draft_id in (${seeded.firstPostId}, ${seeded.latestPostId})
  `;
  await sql`delete from career_mcp.brand_visual_briefs where id = ${seeded.briefId}`;
  await sql`delete from career_mcp.brand_profiles where id = ${seeded.profileId}`;
  await sql`delete from career_mcp.post_drafts where draft_id = ${seeded.draftId}`;
  await sql`
    delete from career_mcp.post_media
    where id in (${seeded.baseMediaId}, ${seeded.sourceMediaId}, ${seeded.renderedMediaId})
  `;
}

async function waitUntilBlocked(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_locks
        where pid = ${pid}
          and not granted
      ) as waiting
    `;
    if (row?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the repository transaction lock barrier");
}

function expectSafeRoleConflict(error: unknown): void {
  const code = postgresField(error, "code");
  expect(code).not.toBe("40P01");
  expect(["DATA_INTEGRITY", "23514", "40001"]).toContain(code);
  if (code === "23514") {
    expect(postgresField(error, "constraint_name"))
      .toBe("brand_source_media_exclusive");
  }
}

liveDescribe("Task 7 real PostgreSQL concurrency", () => {
  it("keeps the claim ledger immutable to runtime across role-template reruns", async () => {
    const clients = await createClients();
    let seeded: Seed | undefined;
    const extraSourceMediaId = randomUUID();
    const extraRenderedMediaId = randomUUID();
    try {
      await assertMigrationApplied(clients.observer);
      await applyRuntimeRoleTemplate(clients.observer);
      seeded = await seed(clients.observer);
      const current = seeded;

      const [privileges] = await clients.observer<{
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
      }[]>`
        select
          has_table_privilege(
            'career_mcp_runtime',
            'career_mcp.media_usage_claims',
            'SELECT'
          ) as "canSelect",
          has_table_privilege(
            'career_mcp_runtime',
            'career_mcp.media_usage_claims',
            'INSERT'
          ) as "canInsert",
          has_table_privilege(
            'career_mcp_runtime',
            'career_mcp.media_usage_claims',
            'UPDATE'
          ) as "canUpdate",
          has_table_privilege(
            'career_mcp_runtime',
            'career_mcp.media_usage_claims',
            'DELETE'
          ) as "canDelete",
          has_table_privilege(
            'career_mcp_runtime',
            'career_mcp.media_usage_claims',
            'TRUNCATE'
          ) as "canTruncate"
      `;
      expect(privileges).toEqual({
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false
      });

      const functions = await clients.observer<{
        name: string;
        securityDefiner: boolean;
        owner: string;
        acl: string | null;
        runtimeCanExecute: boolean;
      }[]>`
        select
          procedure_row.proname as name,
          procedure_row.prosecdef as "securityDefiner",
          pg_get_userbyid(procedure_row.proowner) as owner,
          procedure_row.proacl::text as acl,
          has_function_privilege(
            'career_mcp_runtime',
            procedure_row.oid,
            'EXECUTE'
          ) as "runtimeCanExecute"
        from pg_proc procedure_row
        join pg_namespace namespace_row
          on namespace_row.oid = procedure_row.pronamespace
        where namespace_row.nspname = 'career_mcp'
          and procedure_row.proname in (
            'claim_post_draft_media_usage',
            'claim_brand_source_media_usage'
          )
        order by procedure_row.proname
      `;
      expect(functions).toHaveLength(2);
      for (const fn of functions) {
        expect(fn.securityDefiner).toBe(true);
        expect(fn.owner).not.toBe("career_mcp_runtime");
        expect(fn.acl).not.toMatch(/(?:^\{|,)=X\//);
        expect(fn.runtimeCanExecute).toBe(true);
      }

      for (const operation of [
        (transaction: TransactionSql) => transaction`
          insert into career_mcp.media_usage_claims (
            media_id, owner_subject, purpose, created_at
          ) values (
            ${current.sourceMediaId}, ${current.owner}, 'brand_source', now()
          )
        `,
        (transaction: TransactionSql) => transaction`
          update career_mcp.media_usage_claims
          set purpose = 'brand_source'
          where media_id = ${current.baseMediaId}
        `,
        (transaction: TransactionSql) => transaction`
          delete from career_mcp.media_usage_claims
          where media_id = ${current.baseMediaId}
        `,
        (transaction: TransactionSql) => transaction`
          truncate table career_mcp.media_usage_claims
        `
      ]) {
        expect(postgresField(
          await asRuntimeError(clients.attach, operation),
          "code"
        )).toBe("42501");
      }

      await applyRuntimeRoleTemplate(clients.observer);
      expect(postgresField(
        await asRuntimeError(
          clients.attach,
          (transaction) => transaction`
            delete from career_mcp.media_usage_claims
            where media_id = ${current.baseMediaId}
          `
        ),
        "code"
      )).toBe("42501");

      await clients.observer`
        insert into career_mcp.post_media (
          id, owner_subject, object_path, sha256, mime_type, byte_size,
          width, height, frame_count, original_filename, created_at
        ) values
          (
            ${extraSourceMediaId}, ${current.owner},
            ${`${current.owner}/77/${extraSourceMediaId}.png`}, ${"7".repeat(64)},
            'image/png', 1024, 1200, 627, 1, 'runtime-source.png', now()
          ),
          (
            ${extraRenderedMediaId}, ${current.owner},
            ${`${current.owner}/88/${extraRenderedMediaId}.png`}, ${"8".repeat(64)},
            'image/png', 1024, 1080, 1350, 1, 'runtime-render.png', now()
          )
      `;

      await clients.attach.begin(async (transaction) => {
        await transaction`set local role career_mcp_runtime`;
        await transaction`
          insert into career_mcp.post_draft_media (
            post_draft_id, version, position, media_id, alt_text
          ) values (
            ${current.firstPostId}, 1, 1, ${current.sourceMediaId},
            'Runtime attachment claim'
          )
        `;
      });
      const renderConflict = await asRuntimeError(
        clients.render,
        (transaction) => transaction`
          insert into career_mcp.brand_visual_renders (
            id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
            alt_text, render_checksum, renderer_version, created_at
          ) values (
            ${randomUUID()}, ${current.owner}, ${current.briefId}, 1,
            ${current.sourceMediaId}, ${current.renderedMediaId},
            'Must conflict with runtime attachment', ${"9".repeat(64)}, 1, now()
          )
        `
      );
      expect(postgresField(renderConflict, "code")).toBe("23514");
      expect(postgresField(renderConflict, "constraint_name"))
        .toBe("brand_source_media_exclusive");

      await clients.render.begin(async (transaction) => {
        await transaction`set local role career_mcp_runtime`;
        await transaction`
          insert into career_mcp.brand_visual_renders (
            id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
            alt_text, render_checksum, renderer_version, created_at
          ) values (
            ${randomUUID()}, ${current.owner}, ${current.briefId}, 1,
            ${extraSourceMediaId}, ${extraRenderedMediaId},
            'Runtime source claim', ${"a".repeat(64)}, 1, now()
          )
        `;
      });
      const attachmentConflict = await asRuntimeError(
        clients.attach,
        (transaction) => transaction`
          insert into career_mcp.post_draft_media (
            post_draft_id, version, position, media_id, alt_text
          ) values (
            ${current.firstPostId}, 1, 2, ${extraSourceMediaId},
            'Must conflict with runtime source'
          )
        `
      );
      expect(postgresField(attachmentConflict, "code")).toBe("23514");
      expect(postgresField(attachmentConflict, "constraint_name"))
        .toBe("brand_source_media_exclusive");

      const claims = await clients.observer<{ mediaId: string; purpose: string }[]>`
        select media_id as "mediaId", purpose
        from career_mcp.media_usage_claims
        where media_id in (${current.sourceMediaId}, ${extraSourceMediaId})
        order by media_id
      `;
      expect(new Map(claims.map((claim) => [claim.mediaId, claim.purpose]))).toEqual(
        new Map([
          [current.sourceMediaId, "attached"],
          [extraSourceMediaId, "brand_source"]
        ])
      );
    } finally {
      if (seeded !== undefined) await cleanup(clients.observer, seeded);
      await clients.observer`
        delete from career_mcp.post_media
        where id in (${extraSourceMediaId}, ${extraRenderedMediaId})
      `;
      await closeClients(clients);
    }
  });

  it("lets a direct READ COMMITTED attachment beat SERIALIZABLE commitAndAttach safely", async () => {
    const clients = await createClients();
    let seeded: Seed | undefined;
    let pendingAttachment: Promise<unknown> | undefined;
    let pendingRender: Promise<unknown> | undefined;
    const attachmentInserted = deferred();
    const releaseAttachment = deferred();
    try {
      await assertMigrationApplied(clients.observer);
      seeded = await seed(clients.observer);
      const current = seeded;
      const attachment = clients.attach.begin(async (transaction) => {
        await transaction`set transaction isolation level read committed`;
        await transaction`
          insert into career_mcp.post_draft_media (
            post_draft_id, version, position, media_id, alt_text
          ) values (
            ${current.firstPostId}, 1, 1, ${current.sourceMediaId}, 'Race source'
          )
        `;
        attachmentInserted.resolve();
        await releaseAttachment.promise;
      });
      pendingAttachment = attachment;
      await attachmentInserted.promise;

      const [backend] = await clients.render<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
      `;
      const repositories = createRepositories(drizzle(clients.render, { schema }));
      const render = repositories.brandVisualRenders.commitAndAttach({
        ownerSubject: current.owner,
        briefId: current.briefId,
        expectedDraftId: current.draftId,
        expectedVersion: 1,
        sourceMediaId: current.sourceMediaId,
        renderedMediaId: current.renderedMediaId,
        altText: "Mixed-isolation render",
        renderChecksum: "4".repeat(64),
        rendererVersion: 1,
        checksum: () => "6".repeat(64)
      });
      pendingRender = render;
      await waitUntilBlocked(clients.observer, backend!.pid);
      releaseAttachment.resolve();
      await attachment;
      const renderError = await render.then(
        () => undefined,
        (error: unknown) => error
      );

      expectSafeRoleConflict(renderError);
      const [counts] = await clients.observer<{
        attachments: number;
        renders: number;
        claimPurpose: string;
      }[]>`
        select
          (
            select count(*)::int
            from career_mcp.post_draft_media
            where media_id = ${current.sourceMediaId}
          ) as attachments,
          (
            select count(*)::int
            from career_mcp.brand_visual_renders
            where source_media_id = ${current.sourceMediaId}
          ) as renders,
          (
            select purpose
            from career_mcp.media_usage_claims
            where media_id = ${current.sourceMediaId}
          ) as "claimPurpose"
      `;
      expect(counts).toEqual({
        attachments: 1,
        renders: 0,
        claimPurpose: "attached"
      });
    } finally {
      releaseAttachment.resolve();
      await Promise.allSettled([
        ...(pendingAttachment === undefined ? [] : [pendingAttachment]),
        ...(pendingRender === undefined ? [] : [pendingRender])
      ]);
      if (seeded !== undefined) await cleanup(clients.observer, seeded);
      await closeClients(clients);
    }
  });

  it("lets a direct READ COMMITTED source claim beat SERIALIZABLE createVersionWithMedia safely", async () => {
    const clients = await createClients();
    let seeded: Seed | undefined;
    let pendingSource: Promise<unknown> | undefined;
    let pendingAttachment: Promise<unknown> | undefined;
    const sourceInserted = deferred();
    const releaseSource = deferred();
    try {
      await assertMigrationApplied(clients.observer);
      seeded = await seed(clients.observer);
      const current = seeded;
      const source = clients.attach.begin(async (transaction) => {
        await transaction`set transaction isolation level read committed`;
        await transaction`
          insert into career_mcp.brand_visual_renders (
            id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
            alt_text, render_checksum, renderer_version, created_at
          ) values (
            ${randomUUID()}, ${current.owner}, ${current.briefId}, 1,
            ${current.sourceMediaId}, ${current.renderedMediaId}, 'Race source',
            ${"4".repeat(64)}, 1, now()
          )
        `;
        sourceInserted.resolve();
        await releaseSource.promise;
      });
      pendingSource = source;
      await sourceInserted.promise;

      const [backend] = await clients.render<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
      `;
      const repositories = createRepositories(drizzle(clients.render, { schema }));
      const attachment = repositories.postDrafts.createVersionWithMedia({
        draftId: current.draftId,
        ownerSubject: current.owner,
        text: "Mixed-isolation attachment",
        visibility: "PUBLIC",
        checksum: "mixed-isolation-attachment",
        state: "draft",
        media: [{
          mediaId: current.sourceMediaId,
          altText: "Must remain a brand source"
        }]
      });
      pendingAttachment = attachment;
      await waitUntilBlocked(clients.observer, backend!.pid);
      releaseSource.resolve();
      await source;
      const attachmentError = await attachment.then(
        () => undefined,
        (error: unknown) => error
      );

      expectSafeRoleConflict(attachmentError);
      const [counts] = await clients.observer<{
        attachments: number;
        renders: number;
        claimPurpose: string;
      }[]>`
        select
          (
            select count(*)::int
            from career_mcp.post_draft_media
            where media_id = ${current.sourceMediaId}
          ) as attachments,
          (
            select count(*)::int
            from career_mcp.brand_visual_renders
            where source_media_id = ${current.sourceMediaId}
          ) as renders,
          (
            select purpose
            from career_mcp.media_usage_claims
            where media_id = ${current.sourceMediaId}
          ) as "claimPurpose"
      `;
      expect(counts).toEqual({
        attachments: 0,
        renders: 1,
        claimPurpose: "brand_source"
      });
    } finally {
      releaseSource.resolve();
      await Promise.allSettled([
        ...(pendingSource === undefined ? [] : [pendingSource]),
        ...(pendingAttachment === undefined ? [] : [pendingAttachment])
      ]);
      if (seeded !== undefined) await cleanup(clients.observer, seeded);
      await closeClients(clients);
    }
  });

  it("lets stale render resolve while publish holds the old exact row", async () => {
    const clients = await createClients();
    let seeded: Seed | undefined;
    let pendingPublish: Promise<unknown> | undefined;
    const exactLocked = deferred();
    const continuePublish = deferred();
    const releasePublish = deferred();
    try {
      await assertMigrationApplied(clients.observer);
      seeded = await seed(clients.observer, true);
      const current = seeded;
      const publishLocks = clients.attach.begin(async (transaction) => {
        await transaction`
          select id
          from career_mcp.post_drafts
          where id = ${current.firstPostId} and version = 1
          for update
        `;
        exactLocked.resolve();
        await continuePublish.promise;
        await transaction`
          select id
          from career_mcp.post_drafts
          where draft_id = ${current.draftId}
          order by version desc
          limit 1
          for update
        `;
        await releasePublish.promise;
      });
      pendingPublish = publishLocks;
      await exactLocked.promise;

      const repositories = createRepositories(drizzle(clients.render, { schema }));
      const renderError = await repositories.brandVisualRenders.commitAndAttach({
        ownerSubject: current.owner,
        briefId: current.briefId,
        expectedDraftId: current.draftId,
        expectedVersion: 1,
        renderedMediaId: current.renderedMediaId,
        altText: "Stale render",
        renderChecksum: "4".repeat(64),
        rendererVersion: 1,
        checksum: () => "5".repeat(64)
      }).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(renderError).toBeInstanceOf(DomainError);
      expect(renderError).toMatchObject({
        code: "CONFLICT",
        details: { expectedVersion: 1, actualVersion: 2 }
      });
      continuePublish.resolve();
      releasePublish.resolve();
      await publishLocks;
    } finally {
      continuePublish.resolve();
      releasePublish.resolve();
      if (pendingPublish !== undefined) {
        await Promise.allSettled([pendingPublish]);
      }
      if (seeded !== undefined) await cleanup(clients.observer, seeded);
      await closeClients(clients);
    }
  });
});
