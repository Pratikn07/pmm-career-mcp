# Supabase, Railway, and ChatGPT operator runbook

This is a no-secret production runbook for one private user. It uses placeholders only: do not put database URLs, passwords, tokens, encryption keys, OAuth codes, or `.env` contents in source control, ChatGPT, screenshots, or support tickets.

This repository does not create a Supabase project, Railway service, ChatGPT connector, or LinkedIn application. Complete and validate the following steps in the provider dashboards. Supabase's OAuth authorization server is beta, so a real end-to-end validation is required before treating the deployment as ready.

## 1. Choose the canonical service URL and configuration split

Choose the Railway HTTPS origin first, for example `https://<railway-service-domain>`. Use its canonical form without a trailing slash everywhere it is compared.

| Classification | Values | Operator rule |
| --- | --- | --- |
| Public configuration | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `BASE_URL` | `BASE_URL` is public configuration, but the consent page intentionally exposes only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. These are not database credentials. |
| Host-only, non-secret configuration | `NODE_ENV=production`, `PORT`, `AUTH_MODE=oauth`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `ALLOWED_SUBJECT`, `LINKEDIN_VERSION`, `LINKEDIN_PUBLISH_ENABLED=false`, `LINKEDIN_REDIRECT_URI` | Keep these in Railway environment configuration; do not place them in browser code. |
| Secret, host-only | `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Use Railway secret environment variables. Never commit, log, paste, or enter real values in the example file. |

Set `DATABASE_URL` to the Supabase PostgreSQL shared session-pooler URL on port `5432` with TLS. Set `OIDC_ISSUER` to the exact derived value `SUPABASE_URL/auth/v1`. Set `OIDC_AUDIENCE` to exactly `BASE_URL`, including the same origin and no trailing slash. Set `ALLOWED_SUBJECT` to the UUID of the one permitted Supabase Auth user. Keep `LINKEDIN_PUBLISH_ENABLED=false`.

The active lines in [.env.example](../../.env.example) are copyable local-development defaults and require a local PostgreSQL server. Its production reference entries are commented; set their real values only in Railway. Leave `LINKEDIN_REDIRECT_URI` unset until the later LinkedIn authorization phase, then set it as host-only configuration (not a secret) to `BASE_URL/linkedin/callback`.

## 2. Configure Supabase before connecting the service

1. Create one Supabase project in the intended organization and region.
2. Configure the application schema as `career_mcp`, not `public`. Disable the Supabase Data API for this project because the server connects directly to PostgreSQL. Do not grant `anon` or `authenticated` any privileges on `career_mcp`.
3. Enable asymmetric JWT signing keys for Auth.
4. Create the one permitted Auth user, record only that user's UUID in Railway as `ALLOWED_SUBJECT`, then disable open signups. Do not create a shared or multi-user access path.
5. In Auth URL configuration, set **Site URL** to the canonical Railway `BASE_URL` and **Authorization Path** to `/oauth/consent`.
6. Enable the Supabase OAuth 2.1 authorization server with PKCE and Dynamic Client Registration (DCR). The application accepts only the Supabase-supported `openid` and `email` scopes.

The browser consent page uses `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` only. It must never receive `DATABASE_URL`, any Supabase secret/service-role key, the token-encryption key, or LinkedIn secrets.

## 3. Apply and prove the database migration

Give the deployed service its secret `DATABASE_URL`; do not put it in a command line, chat, or checked-in file. The application runs committed migrations before it opens its listener.

After confirming the target is the intended production Supabase project, run the opt-in smoke command in a trusted shell that already has the secret environment variable:

```bash
CONFIRM_LIVE_SUPABASE_SMOKE=yes npm run smoke:supabase
```

The command must print its safe success confirmation and the transaction rollback confirmation. It rejects non-Supabase or local targets, verifies the schema, performs a marked read/write check inside a rollback-only transaction, and verifies that no marker remains. A failure is a stop condition: inspect the target and provider configuration without exposing the URL or SQL errors.

## 4. Configure and validate OAuth audience behavior

The protected resource is the canonical Railway `BASE_URL`; ChatGPT sends it as the OAuth `resource` parameter. Complete one browser login and explicit consent, then validate the returned access token privately with the configured issuer, audience, and allowed subject:

```bash
npm run verify:oauth-token
```

Provide the token only through `OAUTH_ACCESS_TOKEN` or a non-interactive pipe, as the command requires. It must accept the token only when the signature, expiry, issuer, subject, and exact `BASE_URL` audience are valid. Do not echo the token.

Use the prepared Custom Access Token Hook only after this live test demonstrates that Supabase's native beta OAuth flow issues the wrong `aud` claim. In that case, set the permitted user's administrator-controlled `app_metadata.mcp_audience` to the canonical `BASE_URL`, apply the reviewed hook migration, enable the hook in Supabase, and repeat the token test. Do not enable the hook preemptively or use it to accept a mismatched audience.

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

In ChatGPT, open **Settings → Plugins**, enable **Developer mode**, and create a private connector using:

```text
https://<railway-service-domain>/mcp
```

Complete the browser login and explicit consent. Confirm that ChatGPT can initialize the connector and list the approved tools. Then run a read-only YC search and a draft/preview flow. Keep `LINKEDIN_PUBLISH_ENABLED=false`; no LinkedIn authorization, publish, message, connection request, schedule, or automated posting is part of this deployment check.

## Failure diagnostics

| Symptom | Safe diagnosis |
| --- | --- |
| `/health` fails | Confirm the Railway process started and the public domain routes to the current deployment. Do not treat it as a database test. |
| `/ready` returns unavailable or Railway is unhealthy | Check migration/startup logs and the Railway `DATABASE_URL` secret configuration. Do not copy database errors or the URL into chat. |
| OAuth discovery or consent fails | Recheck `SUPABASE_URL`, the derived issuer, Site URL, Authorization Path `/oauth/consent`, OAuth 2.1/DCR settings, and `openid`/`email` scopes. |
| Token is rejected | Run the private token verifier. Confirm exact issuer, exact canonical `BASE_URL` audience, expiry, and the one allowed subject. Use the hook fallback only after an observed wrong audience. |
| ChatGPT cannot initialize `/mcp` | Confirm the HTTPS connector URL, successful OAuth consent, protected-resource metadata, and a healthy `/ready` endpoint. |
| Any secret appears in output | Revoke or rotate it using the provider, remove it from the exposed location, and repeat only the affected validation. |

Do not mark the production deployment complete until the live smoke, OAuth audience, Railway readiness, and ChatGPT connector checks above have all succeeded with publishing disabled.
