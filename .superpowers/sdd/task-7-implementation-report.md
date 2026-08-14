# Task 7 implementation report

## Delivered

- Added `smoke:supabase`, a deliberately opt-in live smoke command. It requires `CONFIRM_LIVE_SUPABASE_SMOKE=yes`, rejects non-PostgreSQL and local/private targets, applies/verifies the committed application migrations, and uses a UUID marker for a company/person write-read-cleanup cycle.
- Cleanup is attempted after every smoke outcome and is followed by a marker-count check. Command output is a fixed success/failure summary and never includes the connection URL, SQL, database errors, or marker values.
- Added `verify:oauth-token`, which takes a JWT only from `OAUTH_ACCESS_TOKEN` or non-interactive stdin, verifies its remote JWKS signature plus issuer, exact canonical `BASE_URL` audience, expiry, and configured subject, and prints no token or claim values.
- Added an idempotent, dashboard-disabled Custom Access Token Hook fallback. It changes only `claims.aud` from `claims.app_metadata.mcp_audience`, uses `SECURITY INVOKER`, and restricts execution to `supabase_auth_admin`.
- Added focused cleanup, URL-gate, OAuth-claim, and hook-SQL-shape coverage.

## Test-first evidence

The initial focused test run failed at TypeScript build because the new smoke and OAuth script modules did not exist. A subsequent URL-gate regression test failed for private IPv4 targets until the live-target validator was tightened.

## Verification

- `npm test -- tests/scripts/smoke-supabase.test.ts tests/auth/access-token-hook.test.ts tests/scripts/verify-oauth-token.test.ts` — 3 files / 20 tests passed.
- `npm test` — 33 files / 447 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Live-operation status and concerns

No live Supabase project, dashboard, credentials, migration application, or OAuth token was used. The smoke command was not invoked. Before any live use, set the confirmation gate deliberately and verify that the target is the intended Supabase database. Enable the prepared hook in the Supabase dashboard only if a real OAuth token proves that the native resource indicator does not already produce the exact Railway audience.

## Security-review follow-up

- Replaced delete-based marker cleanup with an adapter-owned transaction that always rolls back, including after a failed write or read assertion. A separate, fresh pinned connection then confirms the marker count is zero.
- Restricted `DATABASE_URL` to a credential-free PostgreSQL URL for `db.<project-ref>.supabase.co` or an official `*.pooler.supabase.com` hostname. It rejects arbitrary hosts, URL userinfo, query strings, fragments, local/private forms, and non-public DNS answers. The command resolves once, validates every answer, pins the selected IP for both connections, and retains the original hostname only for TLS certificate verification.
- The live path requires `CONFIRM_LIVE_SUPABASE_SMOKE=yes` before DNS lookup or connection construction. Error output remains a fixed safe summary.
- Added faked resolver/operation tests for the confirmation gate, hostname rejection, private IPv4/IPv6/mapped-address results, rollback after read/write failures, independent fresh-marker verification, and independent connection closure.

Follow-up verification: focused Task 7 tests passed (3 files / 33 tests); the complete suite passed (33 files / 460 tests); type checking, production build, and `git diff --check` passed. No live smoke command was run.

## Second security-review follow-up

- Restored standard credential-bearing PostgreSQL URL support. The smoke script preserves URL userinfo only for the pinned Postgres client and never emits it. It now requires port `5432`, database path `/postgres`, no query, no fragment, and the restricted Supabase database/pooler hostname shapes.
- Simplified the resolver policy to IPv4 only: every IPv6 result is rejected, including ordinary global, NAT64, 6to4, IPv4-mapped, loopback, ULA, and link-local forms. IPv4 private/reserved rejection and IP pinning remain unchanged.
- Added fake-only coverage that proves a realistic pooler URL's credentials reach the pinned client factory privately, while arbitrary hosts still fail before DNS/connection work.

Second follow-up verification: focused Task 7 tests passed (3 files / 38 tests); the complete suite passed (33 files / 465 tests); type checking, production build, and `git diff --check` passed. No live DNS, database, dashboard, credentials, or smoke command was used.
