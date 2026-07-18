# Production Remediation Implementation Plan

> **Required workflow:** Execute each task with `superpowers:subagent-driven-development`. Use test-driven development, a fresh implementer for the task, and a fresh reviewer before advancing.

**Goal:** Make the audited Supabase/Postgres MCP safe and interoperable enough for deployment while preserving all no-autonomous-publishing safeguards.

**Architecture:** Railway will host a stateless Node MCP origin. Supabase Auth issues OAuth tokens enhanced by a mandatory custom access-token hook; Supabase Postgres uses separate migration-owner and least-privilege runtime connections. YC discovery hydrates official company websites from validated YC detail pages. MCP ranking and structured outputs are server-controlled.

**Constraints:** Work only in `/Users/pratik.nandoskar/Documents/working/pmm-career-mcp/.worktrees/supabase-migration` on `codex/supabase-migration`. Never expose secrets, deploy `main`, enable publishing, post to LinkedIn, or initiate a paid plan.

## Task 1: Fix Supabase OAuth, consent, configuration, and HTTP lifecycle

**Files:**

- Modify: `src/oauth/consent-page.ts`
- Modify: `src/oauth/consent-client.ts`
- Modify: `src/auth/resource-auth.ts`
- Modify: `src/config.ts`
- Modify: `src/http/app.ts`
- Modify: `src/mcp/server.ts`
- Modify: `supabase/migrations/20260717000000_mcp_audience_hook.sql`
- Modify: `Dockerfile`
- Modify: corresponding tests under `tests/oauth`, `tests/auth`, `tests/mcp`, `tests/http`, `tests/build`, and `tests/config.test.ts`

- [ ] Add focused tests for a real 32-character alphanumeric authorization ID and rejection of UUID/unsafe values. Run the consent suites and observe the expected failure.
- [ ] Add an OIDC fixture with standard extra fields; add exact-audience tests rejecting audience arrays; add required-scope tests for missing and partial scopes. Run auth tests and observe failures.
- [ ] Add tests proving failed discovery can retry and discovery aborts within the configured timeout.
- [ ] Add config/page tests accepting `sb_publishable_` and legacy `anon` JWT keys while rejecting `sb_secret_`, `service_role`, malformed JWT, and `BASE_URL` paths.
- [ ] Add hook SQL assertions: only OAuth tokens with `client_id` are changed; audience comes only from `app_metadata`; exact `openid email` scope is written; grants remain restricted to `supabase_auth_admin`.
- [ ] Add a transport test proving the MCP server closes exactly once on either response `finish` or premature `close`, and a Docker test proving healthcheck honors `PORT`.
- [ ] Implement a shared authorization-ID validator, permissive required-field OIDC parsing, exact audience/scope checks, timed retryable discovery, safe publishable-key validation, origin-only base URL, required hook behavior, idempotent transport cleanup, and dynamic Docker port.
- [ ] Run:

  ```bash
  npm test -- tests/oauth tests/auth tests/config.test.ts tests/mcp/http-safety.test.ts tests/http tests/build/dockerfile.test.ts
  npm run typecheck
  ```

- [ ] Commit as `fix: make Supabase OAuth interoperable`.

## Task 2: Hydrate official websites for current YC companies

**Files:**

- Modify: `src/research/yc-provider.ts`
- Modify: `src/research/search-provider.ts`
- Modify: `src/research/types.ts` if the source contract needs extension
- Add or modify: `tests/fixtures/yc-company-detail-current.html`
- Modify: `tests/research/yc-provider.test.ts`
- Modify: downstream research/e2e tests only where the public contract changes

- [ ] Add current-layout fixtures and tests showing list cards have no website, detail pages expose an explicit `Company website` link, only filtered companies are hydrated, hydration is bounded, and invalid/non-YC detail URLs are rejected. Observe failure.
- [ ] Add tests showing one detail-page failure does not fail the whole search, failed list discovery is retryable, timeouts are safe, and LinkedIn links are ignored.
- [ ] Extend the source abstraction with a validated detail fetch, hydrate selected results with bounded concurrency, extract and normalize the official link, and preserve null website on safe failure.
- [ ] Run:

  ```bash
  npm test -- tests/research/yc-provider.test.ts tests/research/people-discovery.test.ts tests/research/job-discovery.test.ts tests/e2e/career-flow.test.ts
  npm run typecheck
  ```

- [ ] Perform one read-only live YC smoke check with publishing disabled and no LinkedIn fetch.
- [ ] Commit as `fix: hydrate current YC company websites`.

## Task 3: Harden Postgres TLS, roles, migrations, and pipeline concurrency

**Files:**

- Modify: `src/config.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/pipeline/service.ts`
- Generate: next files under `drizzle/` and `drizzle/meta/`
- Add: `supabase/runtime-role.sql`
- Modify: database, config, repository, and pipeline tests
- Modify: `docs/deployment/supabase-railway-chatgpt.md`

- [ ] Add client tests proving production uses certificate/hostname verification and finite connect/idle/query timeouts. Add config tests requiring distinct `MIGRATION_DATABASE_URL` and `DATABASE_URL` in production. Observe failure.
- [ ] Add repository/service race tests: stale status transitions cannot revive archived targets; score refresh preserves shortlisted/archived status; two transitions have one valid winner.
- [ ] Add schema tests for indexes on all practical foreign-key paths and for new bounded constraints.
- [ ] Split migration and runtime clients, verify TLS, close both on every startup failure, and run migrations under an advisory lock.
- [ ] Change target updates to compare-and-set and score-only updates. Translate zero-row races into a safe conflict without leaking SQL.
- [ ] Update the Drizzle schema and generate the next migration. Add an idempotent operator SQL template that creates/grants the least-privilege runtime role but never contains a real password.
- [ ] Run:

  ```bash
  npm test -- tests/config.test.ts tests/db tests/pipeline/service.test.ts tests/runtime tests/http/readiness.test.ts
  npm run typecheck
  npm run build
  ```

- [ ] Commit as `fix: harden Supabase Postgres runtime`.

## Task 4: Make ranking and MCP outputs server-controlled, then verify release

**Files:**

- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/ranking/score-target.ts` only if a typed public input contract is needed
- Modify: `src/pipeline/service.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/annotations.test.ts`
- Modify: `tests/ranking/score-target.test.ts`
- Modify: `tests/e2e/career-flow.test.ts`
- Modify: `README.md`, `.env.example`, and `docs/deployment/supabase-railway-chatgpt.md`

- [ ] Add MCP tests rejecting caller-supplied numeric component/total scores and proving ranking and saving independently calculate the deterministic server score from typed evidence/preferences. Observe failure.
- [ ] Add per-tool contract tests proving each tool has an explicit success/error output schema and its result validates. Add text-content tests rejecting the generic `Done.` response.
- [ ] Replace numeric-score inputs with raw typed scoring inputs and call `scoreTarget()` inside ranking and saving. Recalculate at persistence time.
- [ ] Define an explicit output schema for every tool, retain the shared safe error envelope and all OAuth/safety annotations, and return bounded useful text.
- [ ] Correct deployment documentation: mandatory access-token hook, origin/audience/scopes, separate migration/runtime roles, verified TLS, secret-entry pauses, publishing disabled, and no nonexistent `/docs` route.
- [ ] Run focused and complete verification:

  ```bash
  npm test -- tests/mcp tests/ranking tests/e2e/career-flow.test.ts
  npm test
  npm run typecheck
  npm run build
  npm audit --omit=dev
  docker build -t pmm-career-mcp:supabase-remediated .
  ```

- [ ] Run container readiness with non-secret test configuration. Run a final diff/security review and confirm no secret, service-role key, password, token, or enabled publishing setting is present.
- [ ] Commit as `fix: enforce MCP scoring and output contracts`.
- [ ] Push `codex/supabase-migration` only after every verification step passes. Do not deploy or start a billable service without separate confirmation.
