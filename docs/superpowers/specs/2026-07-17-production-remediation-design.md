# Production Remediation Design

Date: 2026-07-17

Status: Approved through the production audit and the user's instruction to make the required changes

Scope: `codex/supabase-migration` only

## Objective

Close the release-blocking gaps found in the deep audit without weakening the existing safety model. The result must interoperate with Supabase OAuth, research current YC companies from their public YC and company websites, persist safely in Supabase Postgres, and expose deterministic MCP tools whose inputs cannot bypass server-owned ranking or publishing safeguards.

Publishing remains disabled by default. This remediation does not authorize a LinkedIn post, paid Railway plan, production deployment, or entry of the user's database password.

## 1. Supabase and OpenAI OAuth interoperability

The consent page accepts Supabase's real 32-character alphanumeric `authorization_id`; UUID-shaped values are rejected. The browser and server share one validator so they cannot drift.

OIDC discovery validates the required `issuer` and `jwks_uri` fields but permits additional standards-compliant metadata. Discovery has a bounded timeout and a rejected discovery attempt is not cached forever.

The MCP resource accepts only a token whose:

- signature is valid under the discovered JWKS;
- issuer exactly matches the configured Supabase Auth issuer;
- audience is exactly the canonical MCP origin, not merely one member of an audience array;
- expiration is present and valid;
- subject exactly matches the one configured user; and
- scope contains both `openid` and `email`.

Supabase access tokens do not natively guarantee a `scope` claim for this resource. The existing custom access-token hook therefore becomes a required deployment component. It changes only OAuth tokens carrying a `client_id`, reads the administrator-controlled `app_metadata.mcp_audience`, sets exact `aud`, and adds the fixed resource scope `openid email`. The consent page approves only that exact supported set. The hook never trusts `user_metadata` or a browser-provided audience.

`SUPABASE_PUBLISHABLE_KEY` is safe to embed only when it is an `sb_publishable_` key or a legacy JWT with role `anon`. The application rejects `sb_secret_` keys and legacy `service_role` JWTs before rendering the page. `BASE_URL` is an origin with no credentials, path, query, or fragment.

The MCP HTTP lifecycle closes each per-request server on either response `finish` or `close`, exactly once. Docker readiness uses the runtime `PORT` value.

## 2. Current YC company hydration

The YC directory remains the only company discovery source. Current list cards do not consistently include a company's official website, so the provider first parses and filters the YC list and then hydrates only the selected results from their YC company detail pages.

Hydration is bounded and concurrent. Each detail URL must remain on the expected YC origin and `/companies/<slug>` path. The official website is extracted from the explicit `Company website` link, normalized, and retained only if it is an allowed public HTTP(S) URL. LinkedIn URLs are never fetched or treated as official websites.

If one detail page fails, the search still returns the company without a website. A failed list fetch is subject to a timeout and remains retryable on a later request. People and job research continue to use the existing SSRF-safe public-page fetcher and only run when an official website is available.

## 3. Postgres production hardening

Production TLS verifies the Supabase certificate and hostname rather than merely encrypting without verification. Connection, idle, and query timeouts are finite.

Migrations use `MIGRATION_DATABASE_URL`; normal application queries use `DATABASE_URL`. Production requires both values and rejects identical URLs so the migration owner cannot silently become the runtime application role. The operator creates a least-privilege `career_mcp_runtime` role through a documented SQL template while entering its password privately. The application never generates, prints, or stores that password.

Committed migrations add indexes for foreign-key columns used by joins and deletes, constraints for bounded statuses and scores where appropriate, and an advisory migration lock so multiple instances cannot migrate concurrently.

Pipeline writes use compare-and-set semantics:

- status transitions update only from the expected prior state;
- a stale transition fails safely instead of reviving an archived target;
- score refreshes update scores without resetting an existing workflow status; and
- inserts still begin at `discovered`.

## 4. Deterministic MCP contracts

Numeric networking scores are calculated by `scoreTarget()` on the server. `rank_networking_targets` and `save_target` accept evidence, role, opportunity, preference, and weight inputs—not caller-authored total/component scores—and return the deterministic server result. Saving recalculates the score, so a caller cannot persist forged numeric values from an earlier response.

Every MCP tool declares an explicit structured output schema for its success shape plus the common safe error envelope. Tool text contains a bounded, useful summary instead of the generic `Done.` string. Output schemas must not weaken the existing OAuth security declarations or MCP safety annotations.

The publishing flow is unchanged: publishing is disabled by default, requires the exact immutable preview and one-use token, and never retries an ambiguous external result.

## 5. Documentation and operational truth

Deployment documentation must describe the mandatory Supabase access-token hook, exact OAuth scopes, least-privilege role split, verified TLS, and private password-entry checkpoints. It must not advertise a nonexistent `/docs` endpoint. Examples use the existing project reference but contain no password, service-role key, access token, or LinkedIn secret.

The branch can be pushed after tests, type checking, build, dependency audit, and Docker verification pass. Live Supabase configuration, Railway deployment, and ChatGPT connector setup remain separate external steps and must pause when the user must enter a secret or approve a billable action.

## Verification

Completion requires focused red/green tests for each defect, the full automated suite, typecheck, production build, zero known production dependency vulnerabilities, Docker build/readiness verification, and a final code review. Live YC smoke testing must make no external write. No LinkedIn API publishing call is permitted.
