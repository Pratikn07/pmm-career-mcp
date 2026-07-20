# Supabase, Railway, and ChatGPT operator runbook

This is a no-secret production runbook for one private user. It uses placeholders only: do not put database URLs, passwords, tokens, encryption keys, OAuth codes, or `.env` contents in source control, ChatGPT, screenshots, or support tickets.

This repository does not create a Supabase project, Railway service, ChatGPT connector, or LinkedIn application. Complete and validate the following steps in the provider dashboards. Supabase's OAuth authorization server is beta, so a real end-to-end validation is required before treating the deployment as ready.

## 1. Choose the canonical service URL and configuration split

Choose the Railway HTTPS origin first, for example `https://<railway-service-domain>`. Use its canonical form without a trailing slash everywhere it is compared.

| Classification | Values | Operator rule |
| --- | --- | --- |
| Public configuration | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `BASE_URL` | `BASE_URL` is public configuration, but the consent page intentionally exposes only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. These are not database credentials. |
| Host-only, non-secret configuration | `NODE_ENV=production`, `PORT`, `DATABASE_CA_CERT`, `AUTH_MODE=oauth`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `ALLOWED_SUBJECT`, `LINKEDIN_VERSION`, `LINKEDIN_PUBLISH_ENABLED=false`, `LINKEDIN_IMAGE_PUBLISH_ENABLED=false`, `LINKEDIN_MEDIA_BUCKET=linkedin-draft-media`, `LINKEDIN_REDIRECT_URI` | Keep these in Railway environment configuration; do not place them in browser code. `DATABASE_CA_CERT` is public trust material, not a credential. |
| Secret, host-only | `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Use Railway secret environment variables. Never commit, log, paste, or enter real values in the example file. |

In the Supabase Dashboard, open **Connect**, select the **Session Pooler**, and copy the exact URLs for the project's region. A shared pooler host has the form `aws-<region>.pooler.supabase.com`, and each username must include the project suffix. Use `career_mcp_runtime.<project-ref>` for `DATABASE_URL` and `postgres.<project-ref>` for `MIGRATION_DATABASE_URL`. Percent-encode every password before placing it in a URL (`@` becomes `%40`, for example); do not paste an unencoded password into a connection string. Do not invent the pooler hostname from the project URL.

Set `DATABASE_URL` to the copied Supabase Session Pooler connection for the least-privilege `career_mcp_runtime` role. Set `MIGRATION_DATABASE_URL` to the separate copied owner/migration connection; production startup normalizes direct and pooler aliases, requires the runtime underlying role to be exactly `career_mcp_runtime`, and rejects configurations that reuse the runtime role. In Supabase **Database Settings → SSL Configuration**, download the project's CA certificate and store its complete PEM text as the Railway `DATABASE_CA_CERT` variable. Both connections require that CA and use verified TLS with hostname validation and finite timeouts; do not use `rejectUnauthorized=false`, and do not add TLS query parameters to either URL. Neither URL may override the application's timeout or connection-name parameters. Set `OIDC_ISSUER` to the exact derived value `SUPABASE_URL/auth/v1`. Set `OIDC_AUDIENCE` to exactly `BASE_URL`, including the same origin and no trailing slash. Set `ALLOWED_SUBJECT` to the UUID of the one permitted Supabase Auth user. Keep `LINKEDIN_PUBLISH_ENABLED=false`.

The active lines in [.env.example](../../.env.example) are copyable local-development defaults and require a local PostgreSQL server. Its production reference entries are commented; set their real values only in Railway. Leave `LINKEDIN_REDIRECT_URI` unset until the later LinkedIn authorization phase, then set it as host-only configuration (not a secret) to `BASE_URL/linkedin/callback`.

## 2. Configure Supabase before connecting the service

1. Create one Supabase project in the intended organization and region.
2. Keep the application schema as `career_mcp`, not `public`. Disable the Supabase Data API for this project because the server connects directly to PostgreSQL. Do not grant `anon` or `authenticated` any privileges on `career_mcp`.
3. Run `supabase/runtime-role.sql` with `psql` as the migration owner before the first migration smoke or deployment. The template uses `CREATE SCHEMA IF NOT EXISTS` to create the schema if it does not exist; it never changes ownership of an existing schema. It also installs default privileges so later committed migrations create tables the runtime role can use. The template fails closed if a reused `career_mcp_runtime` login already belongs to any parent role; remove and review every such membership before rerunning it. The final `\password` prompt is the required private checkpoint: enter the runtime password yourself, percent-encode it for the connection URL, store the resulting runtime URL only as `DATABASE_URL`, and never paste the password into chat or source control.
4. In **Storage**, create the application bucket manually with these exact dashboard settings:

   ```text
   Bucket name: linkedin-draft-media
   Public bucket: off
   File size limit: 20 MiB
   Allowed MIME types: image/jpeg, image/png, image/gif
   ```

   This is an explicit user/operator action because the application user JWT is not authorized to create buckets. Do not create or mutate the bucket through SQL, and do not add a secret or service-role key to automate this step. Apply the reviewed `20260719000000_linkedin_media_storage_rls.sql` migration as the database owner; it creates only the owner-folder `SELECT`, `INSERT`, and `DELETE` policies on `storage.objects`. It grants no `UPDATE` policy because uploads use `upsert: false`.
5. Enable asymmetric JWT signing keys for Auth.
6. Create the one permitted Auth user, record only that user's UUID in Railway as `ALLOWED_SUBJECT`, then disable open signups. Do not create a shared or multi-user access path.
7. In Auth URL configuration, set **Site URL** to the canonical Railway `BASE_URL` and **Authorization Path** to `/oauth/consent`.
8. Enable the Supabase OAuth 2.1 authorization server with PKCE and Dynamic Client Registration (DCR). The application accepts only the Supabase-supported `openid` and `email` scopes. Before continuing, confirm `https://<project-ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` returns OAuth metadata with a `registration_endpoint`; a 404 response or a missing registration endpoint means the Supabase OAuth/DCR setup is not ready for ChatGPT. DCR allows MCP clients to register, so regularly monitor registered clients, validate their redirect URIs, and revoke registrations you do not recognize.

The browser consent page uses `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` only. It must never receive `DATABASE_URL`, any Supabase secret/service-role key, the token-encryption key, or LinkedIn secrets.

## 3. Apply and prove the database migration

Give the deployed service both secret database URLs and the non-secret `DATABASE_CA_CERT`; do not put either URL in a command line, chat, or checked-in file. The application uses `MIGRATION_DATABASE_URL` only while holding a transaction-scoped advisory migration lock, closes that pool, and then serves all repository and readiness queries through the least-privilege `DATABASE_URL` pool.

After confirming the target is the intended production Supabase project, run the opt-in smoke command in a trusted shell that already has the secret environment variable:

```bash
CONFIRM_LIVE_SUPABASE_SMOKE=yes npm run smoke:supabase
```

The command must print its safe success confirmation and the transaction rollback confirmation. It rejects non-Supabase or local targets. `MIGRATION_DATABASE_URL` is used only to apply committed migrations and that connection is closed before runtime verification. `DATABASE_URL` is then used only for readiness, schema visibility, rollback-only DML/read verification, and the fresh no-marker check. Every smoke connection is closed on success or failure. A failure is a stop condition: inspect the target and provider configuration without exposing either URL or SQL errors.

## 4. Configure and validate the mandatory OAuth audience hook

The protected resource is the canonical Railway `BASE_URL`. The MCP rejects a token unless its `aud` claim equals that exact URL and its trusted `scope` claim contains exactly the supported resource scopes. Supabase documents Custom Access Token Hooks as the mechanism for setting a third-party resource audience, so the prepared hook is a required deployment component rather than a fallback.

Set the permitted user's administrator-controlled `app_metadata.mcp_audience` to the canonical `BASE_URL`. Apply the reviewed migration [20260717000000_mcp_audience_hook.sql](../../supabase/migrations/20260717000000_mcp_audience_hook.sql) as the database owner, then enable `public.mcp_audience_access_token_hook` in **Authentication → Hooks → Custom Access Token**. The hook changes only OAuth tokens that contain a `client_id`; it never trusts browser input or `user_metadata`. Do not weaken the MCP validator to accept Supabase's default `authenticated` audience.

Complete one browser login and explicit consent, then validate the returned access token privately with the configured issuer, exact audience, allowed subject, and resource scopes:

```bash
npm run verify:oauth-token
```

Provide the token only through `OAUTH_ACCESS_TOKEN` or a non-interactive pipe, as the command requires. It must accept the token only when the signature, expiry, issuer, subject, exact `BASE_URL` audience, and exact `openid email` resource scope set are valid. Do not echo the token.

The token test must pass after the hook is enabled. A failure is a stop condition: confirm the exact canonical URL in `app_metadata.mcp_audience`, hook selection, issuer, subject, and requested `openid email` scopes. Do not bypass an audience or scope mismatch.

Before enabling image workflows, use that same validated OAuth user access token for a live Storage gate against the private `linkedin-draft-media` bucket. Through the Storage API only, upload a uniquely named small supported image under `<token-subject>/...` with `upsert: false`, create a short-lived signed URL or authenticated download, and remove the test object. The upload, read, and removal must all succeed under the owner-folder RLS policies. If Storage rejects the custom-audience OAuth user token, stop the rollout and inspect the token claims, bucket privacy, and policies. Do not add or fall back to a secret key or service-role key.

## 5. Deploy one Railway service

1. Grant the Railway GitHub App access to only this repository, not an organization-wide or unrelated repository scope.
2. Create one service from this repository and use the committed Dockerfile. Do not add persistent storage; the service is stateless and Supabase owns the durable database.
3. Add the environment variables from the split above. Configure secret values in Railway's secret store. Never place them in GitHub configuration or the image build context.
4. Set the service's public domain and make it the exact `BASE_URL`; then revisit the matching Supabase Site URL and OAuth audience values.
5. Deploy. The Docker health check calls `/ready`, so an instance is healthy only after migrations and a database query succeed.

Check these endpoints over the Railway HTTPS domain:

| Endpoint | Expected use |
| --- | --- |
| `/health` | Public liveness probe; it does not query the database. |
| `/ready` | Public readiness probe; it confirms migrations and database availability, and returns only a generic unavailable response on failure. |
| `/.well-known/oauth-protected-resource` | Protected-resource metadata for OAuth discovery. |
| `/mcp` | The private, OAuth-protected MCP endpoint. |

## 6. Connect ChatGPT Developer Mode

Use ChatGPT on the web. For Business, an admin or owner must enable Developer mode and create the app from **Workspace Settings → Apps → Create**. For Enterprise/Edu, an admin or owner enables access and may authorize developers through RBAC; an authorized user then enables **Settings → Apps → Advanced settings → Developer mode** and uses **Settings → Apps → Create**. Pro currently supports custom MCP apps only for read/fetch actions, so use an eligible workspace plan if you need the private pipeline, drafting, or publishing tools. Some older UI versions label Apps as **Plugins** or call the app a connector. Use this endpoint:

```text
https://<railway-service-domain>/mcp
```

Choose OAuth authentication, click **Scan Tools**, complete the browser login and explicit consent, and wait for the scan to finish before creating the private app. Confirm that ChatGPT can initialize it and list the approved tools. Then run a read-only YC search and a draft/preview flow. Keep `LINKEDIN_PUBLISH_ENABLED=false`; no LinkedIn authorization, publish, message, connection request, schedule, or automated posting is part of this deployment check.

Supabase advertises the `refresh_token` grant and issues rotating refresh tokens, but its OAuth discovery does not currently advertise the standard `offline_access` scope that ChatGPT recommends for long-lived OIDC connections. Confirm in the live flow that ChatGPT remains connected after an access-token renewal without inspecting or logging token values. If renewal is not available, document that the private app requires reauthentication after expiry; do not broaden the accepted scopes or expose a refresh token to work around it.

ChatGPT keeps an approved snapshot of tool definitions. If this branch's tool schemas change after the app is created, refresh the app's actions or recreate the draft before testing; do not assume server changes are picked up automatically.

## Failure diagnostics

| Symptom | Safe diagnosis |
| --- | --- |
| `/health` fails | Confirm the Railway process started and the public domain routes to the current deployment. Do not treat it as a database test. |
| `/ready` returns unavailable or Railway is unhealthy | Check migration/startup logs and both Railway database secret configurations. Do not copy database errors or either URL into chat. |
| OAuth discovery or consent fails | Recheck `SUPABASE_URL`, the derived issuer, Site URL, Authorization Path `/oauth/consent`, OAuth 2.1/DCR settings, and `openid`/`email` scopes. |
| Token is rejected | Run the private token verifier. Confirm the mandatory hook is enabled and check the exact issuer, canonical `BASE_URL` audience, expiry, one allowed subject, and `openid email` scopes. Do not bypass a mismatch. |
| ChatGPT cannot initialize `/mcp` | Confirm the HTTPS connector URL, successful OAuth consent, protected-resource metadata, and a healthy `/ready` endpoint. |
| Any secret appears in output | Revoke or rotate it using the provider, remove it from the exposed location, and repeat only the affected validation. |

Do not mark the production deployment complete until the live smoke, OAuth audience, Railway readiness, and ChatGPT connector checks above have all succeeded with publishing disabled.
