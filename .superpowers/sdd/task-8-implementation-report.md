# Task 8 implementation report

## Delivered

- Replaced the example database-path setting with a no-secret Supabase/Railway configuration map. It distinguishes browser-safe public values, host-only configuration, and secrets; production OAuth is enabled, the issuer is derived from the Supabase project origin, the audience matches the canonical service URL, and LinkedIn publishing remains disabled.
- Added `docs/deployment/supabase-railway-chatgpt.md`, an operator-only runbook for a private Supabase schema, disabled Data API, no `anon`/`authenticated` schema grants, asymmetric JWT signing, one Auth user with signups disabled, Supabase OAuth 2.1/DCR, the consent path, Railway repository scope, endpoints, ChatGPT connector setup, and safe failure diagnosis.
- Documented the live Supabase smoke confirmation command and the private OAuth-token audience validation. The Custom Access Token Hook is described only as a fallback after a live token demonstrates the wrong audience claim.
- Reconciled README endpoint wording: `/health` is liveness, while Docker uses `/ready` for migration/database health. README links to the runbook and explicitly states that repository changes do not configure cloud services or validate a live deployment.
- Kept `.dockerignore` unchanged: it excludes local environment files from the Docker context, and the Dockerfile has explicit copy lists that do not copy an environment file. No build input required by the image was excluded.

## Test-first evidence

Added a focused static documentation/configuration test alongside the existing Docker documentation checks. Its first run failed because the required runbook did not exist. After the runbook and configuration documentation were added, the focused suite passed.

## Verification

- `npm test -- tests/build/dockerfile.test.ts` — 4 tests passed.
- Active-document search excluding historical design records found no `DATABASE_PATH`, `SQLite`, `persistent volume`, or `Railway volume` reference in README, `.env.example`, or active deployment documentation.
- Required marker search confirmed `LINKEDIN_PUBLISH_ENABLED=false`, `openid`, `email`, `/oauth/consent`, `/ready`, and `/mcp` across the operational documentation.
- `npm test` — 33 files / 466 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

No Supabase, Railway, ChatGPT connector, LinkedIn, credential, DNS, database, or publishing action was performed.

## Documentation review correction

- Changed the active `.env.example` entries to copyable development defaults: `NODE_ENV=development`, local `BASE_URL`, `AUTH_MODE=none`, and the runtime's local PostgreSQL URL. The README and example now state that a local PostgreSQL server must be available there, or the uncommitted local database URL must be changed before starting the server. Production-only settings are commented Railway references, so copying the example does not activate invalid placeholders or weaken production validation.
- Reclassified `LINKEDIN_REDIRECT_URI` as host-only, non-secret configuration. It is explicitly left unset until the later LinkedIn authorization phase, while client credentials and the encryption key remain Railway secrets.
- Clarified that `BASE_URL` is public configuration but the consent page intentionally exposes only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.

Correction verification: the focused documentation suite passed after the change; the final full-suite, typecheck, build, and diff-check results are recorded with this correction commit. No external configuration or credential action was performed.
