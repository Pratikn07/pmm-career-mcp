import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../../src/db/repositories.js";
import { DomainError } from "../../src/domain/errors.js";
import { schema } from "../../src/db/schema.js";

const databaseUrl = process.env.TASK7_POSTGRES_TEST_DATABASE_URL;
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

async function seed(sql: Sql, stale = false): Promise<Seed> {
  const result: Seed = {
    owner: randomUUID(),
    draftId: randomUUID(),
    firstPostId: randomUUID(),
    latestPostId: stale ? randomUUID() : "",
    profileId: randomUUID(),
    briefId: randomUUID(),
    sourceMediaId: randomUUID(),
    renderedMediaId: randomUUID()
  };
  const latestPostId = stale ? result.latestPostId : result.firstPostId;
  const firstChecksum = "1".repeat(64);
  const latestChecksum = "2".repeat(64);
  const sourceChecksum = "3".repeat(64);
  const renderedChecksum = "4".repeat(64);

  await sql`
    insert into career_mcp.post_media (
      id, owner_subject, object_path, sha256, mime_type, byte_size,
      width, height, frame_count, original_filename, created_at
    ) values
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
    where id in (${seeded.sourceMediaId}, ${seeded.renderedMediaId})
  `;
}

async function waitUntilAdvisoryBlocked(sql: Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<{ waiting: boolean }[]>`
      select exists (
        select 1
        from pg_locks
        where pid = ${pid}
          and locktype = 'advisory'
          and not granted
      ) as waiting
    `;
    if (row?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the render transaction advisory-lock barrier");
}

liveDescribe("Task 7 real PostgreSQL concurrency", () => {
  it("serializes direct attachment against source registration with a two-session barrier", async () => {
    const clients = await createClients();
    let seeded: Seed | undefined;
    let pendingAttachment: Promise<unknown> | undefined;
    let pendingRender: Promise<unknown> | undefined;
    const attachmentInserted = deferred();
    const releaseAttachment = deferred();
    const renderStarted = deferred();
    let renderPid = 0;
    try {
      await assertMigrationApplied(clients.observer);
      seeded = await seed(clients.observer);
      const current = seeded;
      const attachment = clients.attach.begin(async (transaction) => {
        await transaction`
          insert into career_mcp.post_draft_media (
            post_draft_id, version, position, media_id, alt_text
          ) values (
            ${current.firstPostId}, 1, 0, ${current.sourceMediaId}, 'Race source'
          )
        `;
        attachmentInserted.resolve();
        await releaseAttachment.promise;
      });
      pendingAttachment = attachment;
      await attachmentInserted.promise;

      const render = clients.render.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid()::int as pid
        `;
        renderPid = backend!.pid;
        renderStarted.resolve();
        await transaction`
          insert into career_mcp.brand_visual_renders (
            id, owner_subject, brief_id, version, source_media_id, rendered_media_id,
            alt_text, render_checksum, renderer_version, created_at
          ) values (
            ${randomUUID()}, ${current.owner}, ${current.briefId}, 1,
            ${current.sourceMediaId}, ${current.renderedMediaId}, 'Race render',
            ${"4".repeat(64)}, 1, now()
          )
        `;
      });
      pendingRender = render;
      await renderStarted.promise;
      await waitUntilAdvisoryBlocked(clients.observer, renderPid);
      releaseAttachment.resolve();
      await attachment;
      const renderError = await render.then(
        () => undefined,
        (error: unknown) => error
      );

      expect(postgresField(renderError, "code")).toBe("23514");
      expect(postgresField(renderError, "constraint_name"))
        .toBe("brand_source_media_exclusive");
      const [counts] = await clients.observer<{ attachments: number; renders: number }[]>`
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
          ) as renders
      `;
      expect(counts).toEqual({ attachments: 1, renders: 0 });
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
