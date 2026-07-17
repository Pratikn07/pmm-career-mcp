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
