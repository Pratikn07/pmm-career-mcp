# Supabase-Backed Career MCP Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local SQLite persistence with private Supabase Postgres, make all persistence paths asynchronous, add Supabase OAuth consent for ChatGPT, and produce a verified Docker deployment that preserves the no-autonomous-publishing safeguards.

**Architecture:** ChatGPT connects to one stateless Streamable HTTP MCP endpoint hosted by Railway. Railway runs the Docker image and connects over TLS to a private `career_mcp` schema in Supabase Postgres. Supabase Auth is the OAuth 2.1 authorization server; the MCP validates issuer, resource audience, expiration, and the one allowed user subject. Tests use PGlite with the exact committed PostgreSQL migration.

**Tech Stack:** Node.js 22, TypeScript, Express 5, MCP SDK 1.29, Drizzle ORM 0.45, Postgres.js 3.4.9, PGlite 0.5.4, Supabase JS 2.110.7, esbuild 0.28.1, Vitest 4, Docker, Railway.

## Global Constraints

- Work only in `/Users/pratik.nandoskar/Documents/working/pmm-career-mcp/.worktrees/supabase-migration` on `codex/supabase-migration`.
- Follow test-driven development: add a focused failing test, run it and confirm the expected failure, write the minimum implementation, then rerun focused and related tests.
- Use exact versions for every new dependency and commit the lockfile.
- Never expose `DATABASE_URL`, the database password, JWTs, OAuth codes, token encryption keys, or LinkedIn tokens in logs, test output, screenshots, commits, or chat.
- Do not import PGlite from production code. It remains a dev-only test dependency.
- Keep all application tables in `career_mcp`; do not expose that schema through the Supabase Data API and grant no `anon` or `authenticated` access.
- Keep `LINKEDIN_PUBLISH_ENABLED=false` in defaults, examples, Docker, Railway, and all live verification. Do not make a LinkedIn request during deployment verification.
- Preserve every current MCP tool name, input, output, safety annotation, and public domain shape unless this plan explicitly changes it.
- A task is not complete until its focused tests, `npm run typecheck`, and all directly affected suites pass.

---

## Task 1: Establish an asynchronous application contract while retaining SQLite

**Files:**

- Modify: `src/db/client.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/domain/errors.ts`
- Modify: `src/drafts/service.ts`
- Modify: `src/pipeline/service.ts`
- Modify: `src/posts/preview-service.ts`
- Modify: `src/linkedin/oauth.ts`
- Modify: `src/linkedin/posts-client.ts`
- Modify: `src/linkedin/publish-service.ts`
- Modify: `src/research/job-discovery.ts`
- Modify: `src/research/people-discovery.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Modify: database-backed tests under `tests/db`, `tests/drafts`, `tests/pipeline`, `tests/posts`, `tests/linkedin`, `tests/research`, `tests/mcp`, and `tests/e2e`
- Create: `tests/runtime/async-composition.test.ts`

- [ ] Add a focused test that defers one database-backed MCP service promise and proves the tool result stays pending until the promise resolves; add a rejected-promise case that must become a safe domain error.
- [ ] Run `npm test -- tests/mcp/tools.test.ts` and confirm the existing handler returns an unresolved promise-shaped value or otherwise fails the new assertion.
- [ ] Change every repository method returned by `createRepositories()` to a `Promise` contract. For this task only, wrap the current synchronous SQLite statements in `async` methods and make transaction callbacks compatible with awaited callers without changing schema semantics.
- [ ] Change the database lifecycle contract to:

  ```ts
  export type CareerDatabase = ReturnType<typeof createRepositories> & {
    checkReady(): Promise<void>;
    close(): Promise<void>;
  };

  export async function createDatabase(databasePath: string): Promise<CareerDatabase>;
  ```

- [ ] Propagate `async`/`await` through every database-backed service. Use `return await` inside persistence `try/catch` boundaries so asynchronous query failures are translated rather than escaping unsanitized.
- [ ] In `src/pipeline/service.ts`, make `withPipelinePersistenceBoundary` accept `() => Promise<T>` and ensure target validation in shortlist creation is awaited; do not use `forEach(async ...)`.
- [ ] In `src/linkedin/publish-service.ts`, preserve this exact order: consume and claim preview, persist the attempt, make the one external call, persist result, transition the draft. The method must not resolve before completion writes finish.
- [ ] In `src/index.ts`, make `createCareerApplication()` and `startServer()` asynchronous, await every imported YC company upsert, and make connection status asynchronous.
- [ ] In `src/mcp/server.ts`, explicitly await values nested in response objects for drafting, previewing, shortlist, pipeline, notes, history, and connection-status tools. `guarded()` awaiting the outer callback is insufficient.
- [ ] Convert all database-backed tests to async setup/cleanup and awaited assertions. Replace synchronous throw assertions with `await expect(...).rejects` and sync failure spies with `mockRejectedValue`.
- [ ] Add runtime tests proving startup waits for database creation, startup failure opens no listener, persisted YC search waits for every upsert, and shutdown closes HTTP before the database.
- [ ] Run:

  ```bash
  npm test -- tests/mcp/tools.test.ts tests/runtime/async-composition.test.ts
  npm test
  npm run typecheck
  ```

- [ ] Commit with message `refactor: make persistence paths asynchronous`.

---

## Task 2: Replace SQLite with PostgreSQL schema, migrations, and PGlite tests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `drizzle.config.ts`
- Replace: `drizzle/0000_initial.sql`
- Replace: `drizzle/meta/0000_snapshot.json`
- Replace: `drizzle/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/domain/errors.ts`
- Modify: `src/posts/preview-service.ts`
- Create: `tests/support/database.ts`
- Rewrite: `tests/db/repositories.test.ts`
- Modify: all remaining tests that construct a database

- [ ] Pin `postgres` at `3.4.9`; pin dev-only `@electric-sql/pglite` at `0.5.4`; remove `better-sqlite3` and `@types/better-sqlite3`. Regenerate the lockfile with the package manager.
- [ ] Add failing PGlite migration tests that assert `career_mcp` contains exactly the thirteen application tables and that migration discovery works when the current working directory is not the repository root.
- [ ] Add information-schema tests for native `uuid`, `timestamp with time zone`, `boolean`, `double precision`, `jsonb`, and integer version columns. Add round-trip tests proving JSONB is not double-encoded and timestamps leave repositories as canonical ISO strings.
- [ ] Run `npm test -- tests/db/repositories.test.ts` and confirm the new PostgreSQL tests fail against the SQLite implementation.
- [ ] Rewrite `src/db/schema.ts` with `pgSchema("career_mcp")`. Preserve all relationships, unique keys, and both `(draft_id, version)` and `(id, version)` uniqueness for exact-version foreign keys.
- [ ] Replace the migration journal and SQL as one PostgreSQL baseline. The SQL must create the private schema and tables, revoke `PUBLIC`, and conditionally revoke `anon` and `authenticated` only when those roles exist so it also runs in PGlite.
- [ ] Configure Drizzle for `dialect: "postgresql"`.
- [ ] Implement the production client with Postgres.js, a small pool (`max: 5`), required TLS for production, committed migrations before return, `checkReady()` using a harmless awaited query, and `close()` using the driver's async shutdown. Validate only `postgres:` or `postgresql:` URLs and close the pool if migration fails.
- [ ] Implement `tests/support/database.ts` with this test-only API:

  ```ts
  export type TestCareerDatabase = CareerDatabase & {
    resetForTests(): Promise<void>;
  };

  export async function createTestDatabase(): Promise<TestCareerDatabase>;
  ```

  Apply the exact committed migration and reset with schema-qualified `TRUNCATE ... CASCADE`.
- [ ] Port repositories to awaited PostgreSQL statements and array results. Store JSONB directly, normalize all timestamps before returning, validate malformed UUID lookup inputs as not-found, and replace SQLite error inspection with safe PostgreSQL SQLSTATE classification (`23503`, `23505`, `40001`, `40P01`, `22P02`).
- [ ] Replace every `createDatabase(":memory:")` in tests with `await createTestDatabase()`, including awaited reset and close hooks.
- [ ] Replace SQLite WAL/reopen coverage with schema isolation, migration, PostgreSQL type, FK, JSONB, and reset coverage.
- [ ] Run:

  ```bash
  npm test -- tests/db/repositories.test.ts
  npm test
  npm run typecheck
  npm run build
  ```

- [ ] Confirm `rg 'better-sqlite3|DATABASE_PATH|sqliteConstraintKind|sqliteTable' src tests package.json drizzle.config.ts` returns no runtime remnants.
- [ ] Commit with message `feat: migrate persistence to Supabase Postgres`.

---

## Task 3: Prove PostgreSQL transaction and concurrency invariants

**Files:**

- Modify: `src/db/repositories.ts`
- Modify: `src/posts/preview-service.ts`
- Modify: `src/linkedin/publish-service.ts`
- Modify: `tests/db/repositories.test.ts`
- Modify: `tests/posts/preview-service.test.ts`
- Modify: `tests/linkedin/publish-service.test.ts`

- [ ] Add concurrent tests where two outreach versions and two post revisions begin together. Assert unique, contiguous versions and checksums based on the version actually allocated. Cover both an empty version sequence and a pre-existing version.
- [ ] Add concurrent preview consumption and publish tests. Exactly one caller may claim the preview; the LinkedIn client fake must be called once; exactly one attempt may exist.
- [ ] Add rollback tests for a failing discovery refresh, a shortlist whose later entry violates a foreign key, a preview whose post-state claim fails, and a rejected publish-attempt insert. Assert no partial rows remain.
- [ ] Add a deferred `publishAttempts.record` test proving the external LinkedIn client is never called before the durable attempt write resolves. Add deferred completion writes and prove `publish()` remains pending.
- [ ] Run the three focused suites and confirm at least one concurrency or ordering assertion fails before hardening.
- [ ] For outreach and post version allocation, use a PostgreSQL-safe transaction strategy: `SERIALIZABLE`, a deterministic row lock where available, and bounded retries for `40001`/`40P01`; retry `23505` only for the named version constraint.
- [ ] Lock the company row before replacing discovery results. Keep people and evidence replacement in one transaction.
- [ ] Make preview creation serializable against a concurrently added latest version. In consumption, lock the preview row, perform a conditional `consumed_at IS NULL` update, and claim the exact post version in the same transaction.
- [ ] Ensure the PGlite tests validate control flow and constraints, while repository correctness does not rely on PGlite's single-connection scheduling.
- [ ] Run:

  ```bash
  npm test -- tests/db/repositories.test.ts tests/posts/preview-service.test.ts tests/linkedin/publish-service.test.ts
  npm test
  npm run typecheck
  ```

- [ ] Commit with message `test: harden Postgres publishing invariants`.

---

## Task 4: Configure Supabase OAuth resource protection for ChatGPT

**Files:**

- Modify: `src/config.ts`
- Modify: `src/auth/resource-auth.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/auth/resource-auth.test.ts`
- Modify: `tests/auth/http-auth.test.ts`
- Modify: `tests/mcp/annotations.test.ts`

- [ ] Add failing config tests for required `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`; require production `OIDC_AUDIENCE === canonical BASE_URL`; reject `DATABASE_PATH`; keep OAuth and HTTPS production requirements.
- [ ] Add metadata tests that expect only Supabase-supported scopes `openid` and `email`, the canonical resource identifier, and the Supabase Auth issuer.
- [ ] Add MCP annotation tests asserting every tool declares an OAuth 2.0 security scheme with scopes `openid` and `email`; retain all existing read-only/destructive/idempotent/open-world annotations.
- [ ] Run the focused config/auth/MCP tests and confirm failures against `mcp` scope and missing per-tool schemes.
- [ ] Change `AppConfig.databasePath` to `databaseUrl` and add public Supabase consent-page configuration without ever accepting a service-role key.
- [ ] Validate JWTs with issuer, `aud === BASE_URL`, `exp`, and the one `ALLOWED_SUBJECT`. Return the same generic response for missing, malformed, expired, wrong-audience, and wrong-subject access.
- [ ] Advertise `.well-known/oauth-protected-resource` with `openid email`. Preserve a standards-compliant `WWW-Authenticate` challenge pointing to the metadata URL.
- [ ] Add the same OAuth security scheme to all MCP tools. If the SDK needs both standard and compatibility metadata fields, derive both from one constant to prevent scope drift.
- [ ] Run:

  ```bash
  npm test -- tests/config.test.ts tests/auth/resource-auth.test.ts tests/auth/http-auth.test.ts tests/mcp/annotations.test.ts
  npm test
  npm run typecheck
  ```

- [ ] Commit with message `feat: secure MCP with Supabase OAuth`.

---

## Task 5: Add a first-party Supabase login and OAuth consent page

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/oauth/consent-page.ts`
- Create: `src/oauth/consent-client.ts`
- Create: `scripts/build-consent-client.mjs`
- Modify: `src/http/app.ts`
- Create: `tests/oauth/consent-page.test.ts`
- Modify: `tests/health.test.ts`

- [ ] Pin production `@supabase/supabase-js` at `2.110.7` and dev-only `esbuild` at `0.28.1`. Add a deterministic build step that bundles the browser client into `dist/public` without a runtime CDN.
- [ ] Add failing HTTP tests for `GET /oauth/consent?authorization_id=...`: page contains only the public Supabase URL/key configuration, never secret configuration; invalid or missing authorization IDs return a generic safe page; CSP forbids third-party scripts and framing.
- [ ] Add browser-client unit coverage for sign-in, loading OAuth authorization details, explicit approve, and explicit deny. Assert no approval happens on page load and no password is sent to the MCP server.
- [ ] Run `npm test -- tests/oauth/consent-page.test.ts` and confirm the route is absent.
- [ ] Implement a minimal accessible consent page. The server should emit escaped text and a nonce- or hash-compatible restrictive CSP. The client may connect only to the configured Supabase origin.
- [ ] Use Supabase Auth browser APIs for email/password sign-in and the OAuth authorization-details/approve/deny flow. Keep `authorization_id` in memory or the URL, never in server logs.
- [ ] Serve the pinned local bundle with immutable/safe cache headers; do not use inline secrets, third-party fonts, analytics, or external scripts.
- [ ] Add build scripts so `npm run build` compiles TypeScript and the browser bundle.
- [ ] Run:

  ```bash
  npm test -- tests/oauth/consent-page.test.ts tests/health.test.ts
  npm test
  npm run typecheck
  npm run build
  ```

- [ ] Inspect `dist/public` and confirm it contains no `DATABASE_URL`, encryption key, secret key, or service-role token.
- [ ] Commit with message `feat: add Supabase OAuth consent page`.

---

## Task 6: Add readiness, graceful startup, and a production-safe Docker image

**Files:**

- Modify: `src/http/app.ts`
- Modify: `src/index.ts`
- Create: `tests/http/readiness.test.ts`
- Modify: `tests/runtime/async-composition.test.ts`
- Modify: `Dockerfile`
- Modify: `.dockerignore`

- [ ] Add failing readiness tests: `/health` succeeds without querying the database; `/ready` awaits `checkReady()`; database rejection returns `503` with a generic unavailable body and no SQL/connection detail.
- [ ] Add runtime tests proving the listener opens only after migrations, a failed migration leaves no listener, competing shutdown signals are idempotent, and HTTP closes before the database pool.
- [ ] Run focused tests and confirm `/ready` and shutdown expectations fail.
- [ ] Inject readiness into `createHttpApp`, add `/ready`, and keep OAuth off the health/readiness endpoints so Railway can probe them without credentials.
- [ ] Make startup reject safely before listening on database/config failure. Make shutdown stop new HTTP work, wait for server close, then await database close exactly once.
- [ ] Update Docker build layers to include the consent build script/assets and PostgreSQL migration. Remove the SQLite data directory and volume assumptions. Run as the unprivileged `node` user.
- [ ] Change the Docker health check to `/ready` after an adequate startup period.
- [ ] Run:

  ```bash
  npm test -- tests/http/readiness.test.ts tests/runtime/async-composition.test.ts
  npm test
  npm run typecheck
  npm run build
  docker build -t pmm-career-mcp:supabase .
  ```

- [ ] Start the container with deliberately invalid placeholder production configuration and confirm it fails closed without printing a database password. When real Supabase configuration is available, repeat with the live values and confirm `/health` and `/ready` succeed.
- [ ] Commit with message `build: prepare Supabase Docker deployment`.

---

## Task 7: Add safe live Supabase migration and smoke verification

**Files:**

- Create: `scripts/smoke-supabase.ts`
- Create: `scripts/verify-oauth-token.ts`
- Create: `supabase/migrations/20260717000000_mcp_audience_hook.sql`
- Modify: `package.json`
- Create: `tests/scripts/smoke-supabase.test.ts`
- Create: `tests/auth/access-token-hook.test.ts`

- [ ] Add failing tests around the smoke-test cleanup guarantee: even if an intermediate assertion fails, all inserted rows are removed. Reject non-PostgreSQL and clearly local URLs before running.
- [ ] Implement a live script that applies or verifies the committed migration, opens a transaction, writes uniquely marked company/person data, reads it, deletes/rolls back it, and proves no marker remains. Redact the URL and SQL details from errors.
- [ ] Add a token verification script that accepts a token only through a non-echoing input/env channel, verifies issuer, expiry, subject, and exact Railway `BASE_URL` audience, and prints only a safe pass/fail summary.
- [ ] Add an idempotent Custom Access Token Hook migration as the documented fallback. It must read only administrator-controlled `app_metadata.mcp_audience`, mutate `claims.aud`, be `security invoker`, revoke execution from `PUBLIC`, `anon`, and `authenticated`, and grant it only to `supabase_auth_admin`.
- [ ] Add SQL-shape tests for the hook grants and audience source. Do not enable the hook automatically; live testing decides whether Supabase's native resource indicator already produces the correct audience.
- [ ] Add scripts `smoke:supabase` and `verify:oauth-token`.
- [ ] Run:

  ```bash
  npm test -- tests/scripts/smoke-supabase.test.ts tests/auth/access-token-hook.test.ts
  npm test
  npm run typecheck
  npm run build
  ```

- [ ] Commit with message `chore: add Supabase deployment verification`.

---

## Task 8: Update operator documentation and deployment configuration

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/deployment/supabase-railway-chatgpt.md`
- Modify: any existing deployment or backup documentation that mentions SQLite/Railway volumes

- [ ] Add a documentation test or focused text assertions, if an existing documentation-test pattern exists; otherwise use explicit searches listed below.
- [ ] Replace `DATABASE_PATH` and Railway-volume instructions with `DATABASE_URL` using the Supabase shared session pooler and TLS.
- [ ] Document the exact public and secret environment-variable split. Mark `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` public; mark database URL, encryption key, and any future LinkedIn secret as secret.
- [ ] Document Supabase setup: private schema/Data API disabled, asymmetric JWT signing, one Auth user, signup disabled, Site URL set to Railway, Authorization Path `/oauth/consent`, OAuth server and dynamic client registration enabled.
- [ ] Document the audience test and hook fallback, Railway one-repository GitHub App scope, `/health`, `/ready`, `/mcp`, and ChatGPT Settings → Plugins connector flow.
- [ ] Keep LinkedIn as an explicitly later phase. State that posting remains unavailable while `LINKEDIN_PUBLISH_ENABLED=false` and that no automated posting or messaging exists.
- [ ] Verify documentation consistency:

  ```bash
  rg 'DATABASE_PATH|SQLite|persistent volume|Railway volume' README.md docs .env.example
  rg 'LINKEDIN_PUBLISH_ENABLED=false|openid|email|/oauth/consent|/ready|/mcp' README.md docs .env.example
  git diff --check
  ```

  Remaining SQLite mentions are allowed only in historical design records or the explicit note that the old empty local file is not imported.
- [ ] Run `npm test && npm run typecheck && npm run build`.
- [ ] Commit with message `docs: add Supabase Railway runbook`.

---

## Task 9: Final local review and release gate

**Files:**

- Modify only files needed to fix findings; do not add unrequested features.

- [ ] Request a fresh code review against the approved design and this plan. Require the reviewer to inspect database atomicity, async missed-await bugs, secret exposure, OAuth metadata/tool schemes, consent CSP, startup/shutdown, and publishing safeguards.
- [ ] Resolve every high- and medium-severity finding with a failing regression test first. Re-run the directly affected suite after each fix.
- [ ] Run the full release gate from a clean dependency install:

  ```bash
  npm ci
  npm test
  npm run test:coverage
  npm run typecheck
  npm run build
  npm audit --omit=dev
  git diff --check
  git status --short
  docker build -t pmm-career-mcp:supabase .
  ```

- [ ] Start the built image against the configured live Supabase project with publishing disabled. Verify `/health`, `/ready`, protected-resource metadata, and an unauthorized `/mcp` challenge without logging secrets.
- [ ] Confirm the Docker image and source contain no SQLite runtime dependency, database file, OAuth token, cloud secret, or enabled publishing flag.
- [ ] Commit any review fixes with descriptive messages. Do not create a completion-only empty commit.

---

## Task 10: Configure Supabase, push, deploy Railway, and connect ChatGPT

**External state:** Supabase dashboard, GitHub repository `Pratikn07/pmm-career-mcp`, Railway, ChatGPT Developer Mode.

- [ ] Create a free Supabase project in the user's account and chosen organization/region. The user must complete sign-in, organization choice, database-password confirmation, and single-user password entry when the UI requires personal credentials.
- [ ] Apply the committed migration, configure the Auth Site URL and `/oauth/consent` path, enable OAuth 2.1/DCR, create the one allowed Auth user, disable open signup, and run database/security advisors.
- [ ] Run the live database smoke test. Verify the application schema is private and no smoke marker remains.
- [ ] Push `codex/supabase-migration` to `https://github.com/Pratikn07/pmm-career-mcp` and open a reviewable pull request or merge only after all local release gates pass.
- [ ] Grant the Railway GitHub App access to only `Pratikn07/pmm-career-mcp`; deploy its Dockerfile on a free/trial tier where available and add no persistent volume.
- [ ] Set Railway environment values through secret fields. Generate `TOKEN_ENCRYPTION_KEY` locally and never display it. Keep `LINKEDIN_PUBLISH_ENABLED=false` and omit LinkedIn credentials.
- [ ] After Railway assigns HTTPS, update `BASE_URL`, `OIDC_AUDIENCE`, Supabase Site URL, and allowed redirects consistently. Redeploy and verify `/health`, `/ready`, OAuth discovery/resource metadata, consent, and authenticated MCP initialization.
- [ ] Live-test whether Supabase echoes the OAuth resource into `aud`. Enable the prepared access-token hook only if needed, set the allowed user's administrator-controlled `mcp_audience`, and repeat the token verification.
- [ ] In ChatGPT Settings → Plugins, create the private connector with `https://<railway-domain>/mcp`. The user must personally complete Supabase sign-in and approve the consent screen.
- [ ] Verify tool listing, then run one read-only YC-company research query and one draft/preview flow. Confirm publishing reports disabled and no LinkedIn network request or external post occurs.
- [ ] Record the final non-secret URLs, deployment health, tested tool names, and any user-only later work. LinkedIn remains unconfigured until the user separately supplies an approved application and explicitly requests that phase.

