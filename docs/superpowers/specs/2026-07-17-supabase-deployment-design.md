# Supabase-Backed Career MCP Deployment Design

Date: 2026-07-17  
Status: Approved architecture, ready for implementation planning  
Audience: One private user connecting through ChatGPT Developer Mode

## 1. Objective

Replace the local SQLite persistence layer with Supabase Postgres, use Supabase Auth as the OAuth 2.1 authorization server for ChatGPT, and deploy the existing Dockerized MCP server on Railway. Preserve all existing research and LinkedIn publishing safeguards.

The finished system is:

`ChatGPT -> Railway HTTPS endpoint -> Dockerized MCP server -> Supabase Postgres`

Supabase Auth sits beside Postgres and issues the access token that ChatGPT presents to the MCP server.

## 2. Confirmed decisions

- Railway runs the Docker container and supplies the public HTTPS endpoint.
- Supabase replaces SQLite with managed Postgres.
- Supabase Auth is the OAuth 2.1 provider for the ChatGPT connection.
- The MCP server remains a Node.js 22, TypeScript, Express, and Streamable HTTP application.
- Drizzle ORM remains the schema and query layer but changes from SQLite to PostgreSQL.
- The deployment remains private and restricted to one configured Supabase user subject.
- `LINKEDIN_PUBLISH_ENABLED` remains `false` by default.
- No post is published unless the user explicitly requests the exact preview in the current ChatGPT conversation.
- The current local SQLite database is not imported because all application tables contain zero rows.
- The SQLite file is left untouched as a local artifact until the Postgres deployment is verified.

## 3. Alternatives considered

### 3.1 Railway plus SQLite

This is the smallest change and already works locally, but it couples durable data to a single Railway volume and prevents safe multi-instance deployment. It was rejected in favor of a managed database.

### 3.2 Railway plus Supabase Postgres and Auth

This keeps the current MCP runtime and Docker image while moving persistence and identity to managed cloud services. It is the selected design because it preserves the tested application structure and removes the persistent-volume dependency.

### 3.3 Supabase Edge Functions instead of Railway

This could remove the container host, but it would require rewriting the Node/Express runtime for the Supabase Edge Runtime and designing around its execution, CPU, memory, and bundle limits. It is rejected for this version.

## 4. Database architecture

### 4.1 Connection

Production receives one secret `DATABASE_URL` using the Supabase shared session pooler on port `5432`, which is appropriate for a persistent Railway container on an IPv4 network. The application requires TLS and fails startup if the production database URL is missing or is not a PostgreSQL URL.

The application creates a small Postgres.js connection pool and passes it to Drizzle. Graceful shutdown closes the HTTP listener before closing the database connections.

### 4.2 Schema isolation

All application tables live in a non-exposed PostgreSQL schema named `career_mcp`, not `public`. The Supabase Data API is not used by the MCP server and should be disabled for this project. The `anon` and `authenticated` database roles receive no grants on `career_mcp`.

The browser authorization page uses only Supabase Auth and a public publishable key. It never receives the database connection string, the database password, a secret key, or a `service_role` key.

### 4.3 Tables and migrations

The existing thirteen tables and their relationships remain unchanged in meaning:

- `settings`
- `companies`
- `people`
- `evidence`
- `targets`
- `target_notes`
- `outreach_drafts`
- `shortlists`
- `shortlist_entries`
- `post_drafts`
- `post_previews`
- `publish_attempts`
- `oauth_tokens`

Drizzle PostgreSQL migrations create the `career_mcp` schema, tables, unique indexes, and exact-version foreign keys. The application applies committed migrations before accepting traffic. A failed connection or migration prevents the server from starting.

Text UUID identifiers become native PostgreSQL `uuid` columns with application-generated UUID values. ISO timestamp strings become timezone-aware `timestamptz` columns and are returned to domain code as normalized ISO strings at the repository boundary. Boolean and floating-point columns use native PostgreSQL types. JSON stored in `value_json` and `evidence_ids_json` becomes `jsonb`.

### 4.4 Asynchronous repository contract

All database repository operations become asynchronous because Supabase is a network database. Domain services and MCP tool handlers await those operations. Public tool names, inputs, outputs, and safety annotations do not change.

Transactions preserve the existing atomic guarantees for discovery refresh, immutable draft version creation, shortlist creation, preview creation and one-use consumption, and publish-attempt recording. PostgreSQL conditional updates and row locking prevent two callers from consuming the same preview or generating the same next draft version.

### 4.5 Test database

Automated tests use PGlite with the same PostgreSQL schema and migrations. This keeps tests isolated and fast without requiring a live Supabase project or a running Docker daemon. A separate live smoke test verifies the committed migration and a read/write/delete cycle against the actual Supabase project before deployment is considered complete.

## 5. Supabase OAuth architecture

### 5.1 Authorization server

Supabase Auth OAuth 2.1 server capabilities are enabled with PKCE, dynamic client registration, and asymmetric JWT signing keys. The authorization server identifier is:

`https://<project-ref>.supabase.co/auth/v1`

The MCP protected-resource metadata advertises Supabase-supported scopes `openid` and `email`. It does not request the custom `mcp` scope because Supabase Auth does not currently support custom OAuth scopes.

The MCP server validates the JWT signature, issuer, audience, expiry, and subject. Production uses the normal Supabase access-token audience `authenticated`, and `ALLOWED_SUBJECT` contains the UUID of the one permitted Supabase Auth user.

### 5.2 Login and consent page

Railway serves a minimal first-party authorization page at `/oauth/consent`. It accepts the Supabase `authorization_id`, signs the user in directly with Supabase Auth, displays the requesting client and requested scopes, and lets the user approve or deny access. Passwords and sessions go directly between the browser and Supabase; the MCP server does not receive or log them.

The browser client is built into the Docker image from a pinned `@supabase/supabase-js` dependency. The page loads no third-party script and uses a restrictive Content Security Policy. Only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are exposed to the browser; both are designed to be public.

Supabase Auth Site URL points to the Railway HTTPS origin, and its Authorization Path is `/oauth/consent`. Email/password login is the initial single-user sign-in method. Open signup is disabled after the permitted user is created.

### 5.3 Authentication failure behavior

OAuth discovery, token validation, login, and consent failures return generic messages without token contents, claims, database details, stack traces, or secrets. The MCP endpoint continues to return a standards-compliant `WWW-Authenticate` header pointing to its protected-resource metadata.

## 6. Configuration

The production deployment uses these database and Supabase values:

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `OIDC_ISSUER`
- `OIDC_AUDIENCE=authenticated`
- `ALLOWED_SUBJECT`

It also retains:

- `NODE_ENV=production`
- `BASE_URL`
- `AUTH_MODE=oauth`
- `TOKEN_ENCRYPTION_KEY`
- `LINKEDIN_VERSION`
- `LINKEDIN_PUBLISH_ENABLED=false`
- optional LinkedIn credentials only after the user creates and authorizes a LinkedIn application

The removed `DATABASE_PATH` setting is rejected in production documentation and is not used by the runtime.

## 7. Deployment flow

1. Create one Supabase project in the user's selected organization and region.
2. Configure asymmetric JWT signing, the one permitted Auth user, Site URL, authorization path, OAuth 2.1, and dynamic client registration.
3. Apply the committed Postgres migration and run the live database smoke test.
4. Grant the Railway GitHub App access only to `Pratikn07/pmm-career-mcp`.
5. Deploy the existing Dockerfile from the GitHub repository.
6. Set Railway environment values without placing secrets in GitHub or chat.
7. Verify health, protected-resource metadata, OAuth discovery, login/consent, MCP initialization, and tool listing.
8. Add the Railway `/mcp` HTTPS URL in ChatGPT Developer Mode.
9. Verify a read-only YC search and a draft/preview flow with publishing still disabled.
10. Configure LinkedIn only after the user supplies the LinkedIn application details privately.

No Railway persistent volume is required after the Postgres migration.

## 8. Safety invariants

- Research remains limited to YC companies and permitted public sources.
- The system never fetches or automates LinkedIn pages for research.
- The system never sends LinkedIn messages or connection requests.
- The system never schedules, batches, or autonomously publishes posts.
- LinkedIn tokens remain encrypted before storage in Postgres.
- A publish call still requires the exact immutable draft version, checksum, visibility, fresh one-use preview token, and explicit current-conversation request.
- Ambiguous LinkedIn publishing results are never retried automatically.
- `LINKEDIN_PUBLISH_ENABLED=false` remains the default in source, Docker, tests, and deployment configuration.

## 9. Error handling and observability

- Database startup and migration failures stop the process instead of starting a partially functional server.
- Runtime database failures become safe domain errors and never expose connection strings or SQL.
- The existing request correlation ID and log redaction rules remain in place.
- `/health` remains a lightweight process liveness endpoint.
- `/ready` verifies that migrations completed and a simple database query succeeds; Railway uses readiness for deployment verification.
- Graceful shutdown stops new HTTP requests, completes in-flight work within the host timeout, and closes Postgres connections.

## 10. Verification criteria

The migration is complete only when all of the following are true:

- Focused repository tests demonstrate red before implementation and green afterward.
- All repository and domain tests run against PGlite using PostgreSQL migrations.
- The complete automated test suite passes.
- Type checking and production build pass.
- Production dependency audit reports no known vulnerabilities.
- The Docker image builds and its health check passes.
- The live Supabase migration applies successfully.
- A live Supabase read/write/delete smoke test succeeds without leaving test data behind.
- Supabase database advisors report no unresolved security findings relevant to the application schema.
- OAuth protected-resource metadata advertises only supported Supabase scopes.
- A browser login and explicit consent return a token accepted only for the configured subject.
- ChatGPT can initialize the Railway MCP endpoint and list the expected tools.
- A live YC read-only query works.
- Draft and preview tools work while `LINKEDIN_PUBLISH_ENABLED=false`.
- No LinkedIn post or other external write occurs during verification.

## 11. User-only actions

The user must complete or confirm only actions that require personal credentials or explicit external authorization:

- Sign in to Supabase if the browser session is not already authenticated.
- Select the Supabase organization and confirm the project/database password.
- Create or confirm the single Supabase Auth account and password.
- Approve Railway GitHub App access restricted to the one repository.
- Approve the ChatGPT OAuth consent screen.
- Create the LinkedIn developer application, obtain LinkedIn approval for `w_member_social`, and authorize the LinkedIn account before any real publishing test.

The assistant may perform the remaining code, testing, migration, Docker, Railway, and ChatGPT configuration steps within the user's authorized accounts.
