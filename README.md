# PMM Career MCP

A private, single-user MCP server for YC-company career research, a networking pipeline, and deliberately controlled text-only LinkedIn publishing. It is designed for ChatGPT Developer Mode. It does not scrape LinkedIn, send LinkedIn messages, make connection requests, or post without an explicit request for the exact preview in the current ChatGPT conversation.

## Start locally

Use Node.js 22 or later. Keep secrets in a local `.env` file or the host's secret store—never paste them into a ChatGPT conversation. Both `npm run dev` and `npm start` load `.env` automatically when it exists; process or host environment variables can still provide the same values.

```bash
cp .env.example .env
npm ci
npm run build
npm test
npm run dev
curl --fail http://127.0.0.1:3000/health
```

The server applies its committed PostgreSQL migrations and verifies database readiness before opening its HTTP listener. For local development, `AUTH_MODE=none` is allowed only outside production; publishing stays off by default.

The copied example connects both database variables to `postgresql://postgres:postgres@127.0.0.1:5432/postgres`; start a local PostgreSQL server there, or change both `DATABASE_URL` and `MIGRATION_DATABASE_URL` in your uncommitted `.env` before running the server. Local development may use the same role for both. The production values remain commented reference entries in the example and must be set in Railway instead.

`/health` is a public, database-independent liveness endpoint. `/ready` is the database and migration readiness endpoint. The Docker health check calls `/ready`, and it returns only a generic unavailable response when the database is not ready.

## Deploy and connect ChatGPT

The detailed, no-secret operator runbook is [docs/deployment/supabase-railway-chatgpt.md](docs/deployment/supabase-railway-chatgpt.md). It covers the private Supabase schema and Auth setup, the Railway service configuration, the required OAuth audience validation, failure diagnostics, and the ChatGPT Developer Mode connector.

Production needs an HTTPS hostname, a TLS-enabled least-privilege Supabase PostgreSQL `DATABASE_URL`, a distinct owner-only `MIGRATION_DATABASE_URL`, and `AUTH_MODE=oauth`. The container is stateless:

```bash
docker build -t career-mcp:local .
docker run --rm -p 3000:3000 --env-file .env career-mcp:local
```

Use the app's HTTPS endpoint in ChatGPT Developer Mode:

```text
https://your-host.example/mcp
```

Repository changes do not create or configure a Supabase project, Railway service, OAuth client, ChatGPT connector, or LinkedIn application. Those remain explicit operator actions in the runbook and require live validation.

Use Supabase managed backups for the production database and treat them as private career data because they can contain encrypted LinkedIn tokens. Follow the provider's restore procedure in a controlled environment.

## LinkedIn is a later phase

`LINKEDIN_PUBLISH_ENABLED=false` is the default and must remain false during deployment and connector checks. While it is false, the server cannot publish. There is no automated posting, retry, scheduling, messaging, or connection-request capability.

Only after the private deployment and read-only MCP flow are working should an operator create a LinkedIn app, set the host-only (non-secret) `LINKEDIN_REDIRECT_URI` to `https://your-host.example/linkedin/callback`, and add the LinkedIn client values plus a 64-character hexadecimal `TOKEN_ENCRYPTION_KEY` to the host's secret store. Leave the redirect URI unset before that later phase. Tokens are encrypted in managed PostgreSQL and are never returned by MCP tools.

Every real post still requires the exact immutable draft version, checksum, visibility, and a fresh one-use preview token. If a publish result is unknown, do not retry: first check LinkedIn manually, then create a new draft version and preview before a new explicit request.

## Operating rules

- Never paste client secrets, access tokens, refresh tokens, encryption keys, OAuth states, database URLs, or `.env` contents into ChatGPT.
- Research is limited to YC companies and allowed public company sources; people coverage is best-effort, never a complete directory.
- YC company discovery uses an official server-rendered YC industry or location facet page selected from the query. Every MCP response includes a page-scoped coverage summary—even when no company matches—so an empty result is never presented as proof of complete YC-wide coverage.
- Drafts, previews, shortlists, targets, and notes stay private in the managed database.
- A failed or unknown publish attempt is not permission to retry automatically. Resolve it deliberately and create a fresh preview when needed.

## Verification status

Local automated checks cover the database migration path, OAuth validation, readiness behavior, and publishing safety. A production deployment is not verified until the operator completes the runbook's live Supabase smoke, OAuth audience, Railway readiness, and ChatGPT connector checks with `LINKEDIN_PUBLISH_ENABLED=false`.
