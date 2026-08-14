# Task 7 Media Usage Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Task 7 ownership leak and enforce attached-versus-brand-source media exclusivity through one persistent PostgreSQL claim row.

**Architecture:** Add a private `career_mcp.media_usage_claims` table keyed by `post_media.id`; both attachment and render-source triggers arbitrate by inserting/upserting that same row. Before a stale render response, non-locking lineage validation proves both the brief’s exact post media and the current latest post media belong to the caller; successful writes repeat the existing locked validation.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL/PLpgSQL, PGlite, Vitest, postgres.js

## Global Constraints

- Use TDD and preserve identical safe `NOT_FOUND` errors for foreign, corrupt, or absent post lineage.
- Keep all new state in the private `career_mcp` schema with `SECURITY INVOKER` trigger functions.
- Preserve runtime-role access; add no service-role, Storage, preview, approval, publish, deployment, or live-service behavior.
- Revise undeployed migration `0005` rather than adding `0006`.
- Guard real PostgreSQL tests with both a dedicated acknowledgement and a strict local-host check.
- Do not edit `.superpowers/sdd/progress.md`.

---

### Task 1: Reproduce stale-lineage and activation defects

**Files:**
- Modify: `tests/db/repositories.test.ts`
- Modify: `tests/db/brand-media-concurrency.integration.test.ts`

**Interfaces:**
- Consumes: `brandVisualRenders.commitAndAttach(...)`
- Produces: regression assertions for safe lineage errors and local-only guarded-test activation

- [x] **Step 1: Add a failing repository test**

Create caller-owned briefs whose exact/latest post lineage resolves to foreign,
unattached, and absent media, call `commitAndAttach`, and assert all responses
equal `{ code: "NOT_FOUND", details: { entity: "post_draft" } }` without
`actualVersion`.

- [x] **Step 2: Add a failing activation test**

Extract guarded-test configuration parsing so the suite requires
`TASK7_POSTGRES_TEST_ACK=local-docker-only` and accepts only `localhost`,
`127.0.0.1`, or `::1`.

- [x] **Step 3: Run the focused tests**

Run:
`npx vitest run tests/db/repositories.test.ts tests/db/brand-media-concurrency.integration.test.ts`

Expected: the new stale-lineage test exposes `CONFLICT.actualVersion`, and the
guard assertions fail against URL-only activation.

### Task 2: Specify the persistent claim schema and trigger behavior

**Files:**
- Modify: `tests/db/repositories.test.ts`
- Modify: `tests/db/schema-hardening.test.ts`
- Modify: `tests/db/runtime-role.test.ts`
- Modify: `tests/support/database.ts`

**Interfaces:**
- Produces: database contract for
  `media_usage_claims(media_id, owner_subject, purpose, created_at)`

- [x] **Step 1: Add failing schema inventory and constraint tests**

Expect the twentieth private table, its primary/foreign key, owner index, and
`purpose in ('attached','brand_source')` check.

- [x] **Step 2: Add failing trigger/backfill tests**

Assert same-purpose duplicates succeed, opposite-purpose insert/update paths
raise SQLSTATE `23514` with constraint `brand_source_media_exclusive`, and the
claim row retains exactly one purpose.

- [x] **Step 3: Add failing migration-security tests**

Require attachment-first/source-second backfill, `INSERT ... ON CONFLICT`,
private-schema invoker functions, and no advisory-only, service-role, Storage,
or public-role grants.

- [x] **Step 4: Run the focused database tests**

Run:
`npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts`

Expected: failures identify the missing table, claim rows, schema inventory,
and migration SQL.

### Task 3: Implement owner-safe lineage validation and claims

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories.ts`
- Replace: `drizzle/0005_brand_source_media_exclusive.sql`
- Replace: `drizzle/meta/0005_snapshot.json`
- Modify: `tests/support/database.ts`

**Interfaces:**
- Produces: `mediaUsageClaims` Drizzle table and
  `validateOwnedBrandPostMedia(...)`

- [x] **Step 1: Implement non-locking lineage validation**

Read exact and latest attachment IDs, then read their `post_media` rows without
locks. Reject missing attachment rows, missing media rows, foreign owners,
foreign object-path prefixes, or invalid SHA-256 values before evaluating
staleness. Leave the existing locked revalidation in the successful path.

- [x] **Step 2: Add the Drizzle claim table**

Define `media_id` as the primary key and FK to `post_media` with
`ON DELETE CASCADE`, plus `owner_subject`, constrained `purpose`, `created_at`,
and an owner index. Export it in `schema`.

- [x] **Step 3: Regenerate undeployed migration metadata**

Remove only the generated `0005` migration/snapshot/journal entry, regenerate
`0005` from the updated schema, then replace its SQL with the reviewed
table/backfill/invoker-trigger implementation while retaining the generated
snapshot and journal metadata.

- [x] **Step 4: Implement claim arbitration**

Each trigger inserts its desired purpose into `media_usage_claims` and uses
`ON CONFLICT (media_id) DO UPDATE ... WHERE existing purpose = desired purpose`.
If no row is returned, raise SQLSTATE `23514` with
`brand_source_media_exclusive`. Backfill attachments first, then sources.

- [x] **Step 5: Run focused tests to GREEN**

Run the Task 1 and Task 2 commands and require all deterministic tests to pass.

### Task 4: Prove mixed-isolation behavior and complete verification

**Files:**
- Modify: `tests/db/brand-media-concurrency.integration.test.ts`
- Modify: `.superpowers/sdd/task-7-report.md` (ignored evidence report)

**Interfaces:**
- Consumes: actual SERIALIZABLE repository methods and one direct READ COMMITTED writer
- Produces: guarded local-Docker race proof in both winner orders

- [x] **Step 1: Implement both guarded race orders**

Race direct READ COMMITTED attachment against repository
`commitAndAttach`, then direct READ COMMITTED source registration against
repository `createVersionWithMedia`. Use claim-row lock observation/barriers,
accept a safe domain conflict/constraint or retryable `40001`, assert no
`40P01`, and prove no media ID has both roles.

- [x] **Step 2: Run focused verification**

Run repository, migration, schema, render, renderer, and media tests, including
the guarded file in its fail-closed skipped mode.

- [x] **Step 3: Run final verification once**

Run `npm test` once, followed by `npm run typecheck`, `npm run build`,
`npx drizzle-kit check`, and `git diff --check`.

- [x] **Step 4: Document and commit**

Append RED/GREEN evidence and the exact safe Task 11 command to
`.superpowers/sdd/task-7-report.md`, verify `.superpowers/sdd/progress.md` is
unchanged, stage only scoped files, inspect the staged patch, and commit with
`fix: persist branded media usage claims`.
