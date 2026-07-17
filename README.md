# PMM Career MCP

A private, single-user MCP server for YC-company career research, a networking pipeline, and carefully controlled text-only LinkedIn post publishing. It is designed for ChatGPT Developer Mode. It does not scrape LinkedIn, send LinkedIn messages, make connection requests, or post without an explicit request in the current ChatGPT conversation.

## Start locally

Use Node.js 22 or later. Keep secrets in a local `.env` file or your hosting provider's secret store—never paste them into a ChatGPT conversation. Both `npm run dev` and `npm start` load `.env` automatically when it exists; process or host environment variables can still provide the same values.

```bash
cp .env.example .env
npm ci
npm run build
npm test
npm run dev
curl --fail http://127.0.0.1:3000/health
```

The server applies its committed PostgreSQL migrations and verifies database readiness before opening its HTTP listener. For local development, `AUTH_MODE=none` is allowed only outside production and publishing stays off by default.

The Docker health check calls `/health` because it is deliberately a process-liveness probe. Configure Railway deployment readiness verification to call `/ready`; it additionally checks the migrated database without exposing database errors or connection details.

## Host and connect ChatGPT

Production needs an HTTPS hostname, a PostgreSQL/Supabase `DATABASE_URL`, and a real OAuth provider. The container is stateless and needs no persistent volume:

```bash
docker build -t career-mcp:local .
docker run --rm -p 3000:3000 --env-file .env career-mcp:local
```

For an initial local check, expose the server through a secure HTTPS tunnel that you control. Do not make a no-auth tunnel public. Before production, set `NODE_ENV=production`, use an HTTPS `BASE_URL`, set `AUTH_MODE=oauth`, and configure all of `OIDC_ISSUER`, `OIDC_AUDIENCE`, `ALLOWED_SUBJECT`, and `TOKEN_ENCRYPTION_KEY`.

In ChatGPT, open **Settings → Plugins**, enable **Developer mode**, then create an app/connector with the HTTPS MCP endpoint:

```
https://your-host.example/mcp
```

Choose OAuth for production. The identity provider must support OpenID Connect discovery, a JWKS endpoint, PKCE, and access tokens whose issuer and audience match `OIDC_ISSUER` and `OIDC_AUDIENCE`. Configure it to issue the `mcp` scope and restrict access to the single `ALLOWED_SUBJECT`. The server publishes protected-resource metadata at `/.well-known/oauth-protected-resource`.

## Link LinkedIn

Create a LinkedIn app for the account that will publish. Request the minimum version-1 scopes: `openid`, `profile`, and `w_member_social`. Add this exact redirect URI in LinkedIn and set the matching environment value:

```
https://your-host.example/linkedin/callback
```

Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, and a 64-character hexadecimal `TOKEN_ENCRYPTION_KEY` in the host's secret store. Restart the service, use `create_linkedin_authorization_url`, complete the browser authorization, then check `get_linkedin_connection_status`. Tokens are encrypted in SQLite and are never returned by MCP tools.

## Publishing safety

`LINKEDIN_PUBLISH_ENABLED=false` is the default and the Docker image does not enable it. Leave it false while testing. To allow a real post, change only the host secret/environment setting to `true`, restart, and use the normal preview flow. ChatGPT must still receive an explicit request to publish the exact preview in the current conversation.

Every post requires the exact immutable draft version, checksum, visibility, and a fresh one-use preview token. The server makes one LinkedIn create-post request only. It never batch-publishes or schedules posts. If LinkedIn times out, returns a 5xx/429, or returns an incomplete success response, the result is `publish_unknown`: do **not** retry. Check LinkedIn manually for the post first. If no post exists, create a new draft version, preview it again, and make a new explicit request.

## Backups and credential rotation

Stop the service before copying a SQLite file, or use SQLite's online backup command so the WAL is captured consistently. Store encrypted backups separately from the encryption key:

```bash
sqlite3 data/career-mcp.sqlite ".backup 'backups/career-mcp-$(date +%F).sqlite'"
```

Test restores in an isolated directory by setting `DATABASE_PATH` to the restored file before relying on a backup. Backups contain encrypted LinkedIn tokens, but should still be treated as private career data.

For routine LinkedIn token rotation, revoke the old LinkedIn grant if required, remove the saved LinkedIn token through your controlled maintenance process, restart, and reconnect through `create_linkedin_authorization_url`. Keep the same encryption key for existing encrypted data. Encryption-key rotation requires a planned offline decrypt-and-reencrypt migration: back up first, run the migration in a trusted environment, verify a restore, then deploy the new key. Simply changing `TOKEN_ENCRYPTION_KEY` makes prior encrypted tokens unreadable.

## Operating rules

- Never paste client secrets, access tokens, refresh tokens, encryption keys, OAuth states, or `.env` contents into ChatGPT.
- Research is limited to YC companies and allowed public company sources; people coverage is best-effort, never a complete directory.
- YC company discovery uses an official server-rendered YC industry or location facet page selected from the query. Every MCP response includes a page-scoped coverage summary—even when no company matches—so an empty result is never presented as proof of complete YC-wide coverage.
- The only external write is a text post through LinkedIn's official API. Drafting, previews, shortlists, targets, and notes stay private in the SQLite volume.
- A failed or unknown publish attempt is not permission to retry automatically. Resolve it deliberately and create a fresh preview when needed.

## Acceptance evidence and handoff

The table maps the approved design to automated proof or an explicit operator check. “Manual” items are intentionally not performed by the server or test suite.

| Approved criterion | Evidence |
| --- | --- |
| Private, single-user, hosted streaming-HTTP MCP with health, Docker, and persistent SQLite | `src/http/app.ts`, `src/index.ts`, `Dockerfile`, migration/repository tests, and `tests/e2e/career-flow.test.ts`. |
| Production is OAuth-protected; local no-auth is development/test only | `tests/auth/resource-auth.test.ts`, `tests/auth/http-auth.test.ts`, and `tests/config.test.ts` prove issuer/audience/subject/expiry/JWKS checks, protected-resource metadata, and production fail-closed configuration. |
| YC-only research, public-company sources, best-effort people coverage, citations, freshness, and transparent ranking | `tests/research/*.test.ts` and `tests/ranking/score-target.test.ts`; tool descriptions explicitly state authoritative-page-only/best-effort coverage. |
| No LinkedIn scraping or unsafe public-page access | URL policy/fetch tests cover LinkedIn denial, SSRF/private-network/redirect/content bounds, and untrusted-content sanitization. |
| Private pipeline, notes, shortlists, outreach drafts, immutable post history, and versioned schema | `tests/db/repositories.test.ts`, `tests/pipeline/service.test.ts`, and `tests/drafts/service.test.ts`. |
| Complete tool contract with strict schemas and correct read/write annotations | `tests/mcp/tools.test.ts` and `tests/mcp/annotations.test.ts`; the registered tool set excludes messaging, connection, profile, schedule, and batch tools. |
| LinkedIn OAuth uses PKCE, encrypted server-side tokens, and a non-secret status response | `tests/linkedin/oauth.test.ts`, `tests/security/crypto.test.ts`, and `get_linkedin_connection_status`; callback and status return no credentials. |
| Text-only LinkedIn Posts API integration is version-configured and sends no automatic retries | `tests/linkedin/posts-client.test.ts` and `tests/linkedin/publish-service.test.ts`. |
| Publishing is disabled by default and requires an exact current draft, checksum, visibility, one-use 15-minute preview, and explicit MCP write call | `tests/posts/preview-service.test.ts`, `tests/linkedin/publish-service.test.ts`, and the mocked full flow in `tests/e2e/career-flow.test.ts`. It records success, definite failure, or unknown outcome and never retries ambiguous creation. |
| No autonomous work, scheduled posts, LinkedIn messages/connections, media posts, multi-user features, or private-profile data | The approved MCP tool inventory and server instructions (`src/mcp/server.ts`) contain none of those capabilities; `tests/mcp/tools.test.ts` guards the inventory. |
| Secrets are encrypted/redacted and are absent from source, Docker context, and tool errors | `tests/security/crypto.test.ts`, secret-handling tests, `.dockerignore`, and the verification audit below. Test fixtures use clearly fake values only. |
| Safe error handling, source-change visibility, bounded retries, backups, rotation, and deployment guidance | Research/publish/auth tests plus the backup, rotation, and ambiguous-publish runbooks above. A changed YC page returns a safe error rather than invented results. |
| Clean verification | On 2026-07-17: `npm test` (347 tests), `npm run typecheck`, `npm run build`, and two consecutive coverage runs passed. The production-only dependency audit is clean; the development dependency audit has four non-production moderate advisories. |
| Live source and temporary HTTPS smoke | On 2026-07-17, a no-auth development server with publishing disabled was reached through a temporary HTTPS tunnel. MCP initialization listed 18 tools; draft and preview completed without credentials or a publish call. The initial YC source-change response led to a parser update; subsequent direct live checks returned 50 companies from YC's official recruiting page and 34 marketing matches. No ChatGPT connector/app was created. |
| Production OAuth, ChatGPT connector, LinkedIn authorization, and any real post | **Manual, user-controlled handoff:** deploy to an HTTPS host with a persistent volume; configure the production OAuth values and keep `LINKEDIN_PUBLISH_ENABLED=false`; create the ChatGPT Developer Mode connector yourself; then connect LinkedIn privately. Enable the kill switch only when ready, and make any real post only through a newly previewed draft and an explicit current-conversation request. |
