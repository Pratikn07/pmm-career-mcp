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

Set `DATABASE_URL` to the copied Supabase Session Pooler connection for the least-privilege `career_mcp_runtime` role. Set `MIGRATION_DATABASE_URL` to the separate copied owner/migration connection; production startup normalizes direct and pooler aliases, requires the runtime underlying role to be exactly `career_mcp_runtime`, and rejects configurations that reuse the runtime role. In Supabase **Database Settings → SSL Configuration**, download the project's CA certificate and store its complete PEM text as the Railway `DATABASE_CA_CERT` variable. Both connections require that CA and use verified TLS with hostname validation and finite timeouts; do not use `rejectUnauthorized=false`, and do not add TLS query parameters to either URL. Neither URL may override the application's timeout or connection-name parameters. Set `OIDC_ISSUER` to the exact derived value `SUPABASE_URL/auth/v1`. Set `OIDC_AUDIENCE` to exactly `BASE_URL`, including the same origin and no trailing slash. Set `ALLOWED_SUBJECT` to the UUID of the one permitted Supabase Auth user.

Keep both switches false through deployment and all pre-rollout checks. `LINKEDIN_PUBLISH_ENABLED` is the master gate for text and image posts. `LINKEDIN_IMAGE_PUBLISH_ENABLED` is an additional gate required whenever a draft contains images. Enabling a switch makes the app-only path available; it never authorizes an individual post or makes publishing automatic.

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

### Founder-research migration journal and release boundary

For the founder-research release, deploy only the Git branch `codex/founder-research-export`; never deploy `main`. Do not request, initiate, or approve a paid plan or upgrade as part of this release.

Apply the existing committed Drizzle migrations through the application's normal migration path, in the exact order recorded by `drizzle/meta/_journal.json`:

```text
0000_initial
0001_schema_hardening
0002_linkedin_media_review
0003_linkedin_preview_snapshot
0004_pmm_brand_studio
0005_brand_source_media_exclusive
0006_brand_brief_source_claims
0007_yc_founder_research_export
0008_outreach_request_id
0009_outreach_request_payload_hash
0010_outreach_request_identity_null_pair
0011_founder_export_idempotency
```

These correspond to the committed `drizzle/0000_initial.sql` through `drizzle/0011_founder_export_idempotency.sql` files. Do not invent, rename, reorder, or hand-edit a migration filename. The separately committed provider-side SQL files are `supabase/migrations/20260717000000_mcp_audience_hook.sql` and `supabase/migrations/20260719000000_linkedin_media_storage_rls.sql`; follow their existing reviewed runbook steps in sections 2 and 4. Use the existing private migration path only. If it prompts for a password or other secret, pause and let the authorized operator enter it privately; never paste, echo, or record it.

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

1. Grant the Railway GitHub App access to only this repository, not an organization-wide or unrelated repository scope. For the founder-research release, select only `codex/founder-research-export`; never select or deploy `main`, and do not request a paid plan or upgrade.
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

Choose OAuth authentication, click **Scan Tools**, complete the browser login and explicit consent, and wait for the scan to finish before creating the private app. Confirm that ChatGPT can initialize it and list the approved tools. Then run a read-only YC search and a private draft flow. Keep both publishing switches false; no LinkedIn publish, message, connection request, or automated posting is part of this deployment check.

Confirm the tool boundary after every connector refresh:

- Model-visible: research and pipeline tools, `draft_linkedin_post`, `revise_post`, `attach_linkedin_post_images`, `set_linkedin_post_images`, `list_post_history`, and the non-writing `open_linkedin_review_card` launcher.
- App-only: `create_exact_linkedin_preview` and `publish_exact_linkedin_post`. Both must have `_meta.ui.visibility: ["app"]`; the legacy `preview_post` and `publish_linkedin_post` names must be absent.

The launcher may render a selected immutable draft and short-lived private image URLs, but it must create no preview row, capability, LinkedIn image initialization, upload, or post. Exact preview creation occurs only after the user opens the interactive card and clicks its control. Publishing occurs only after a successful exact preview and a separate final confirmation.

Supabase advertises the `refresh_token` grant and issues rotating refresh tokens, but its OAuth discovery does not currently advertise the standard `offline_access` scope that ChatGPT recommends for long-lived OIDC connections. Confirm in the live flow that ChatGPT remains connected after an access-token renewal without inspecting or logging token values. If renewal is not available, document that the private app requires reauthentication after expiry; do not broaden the accepted scopes or expose a refresh token to work around it.

ChatGPT keeps an approved snapshot of tool definitions. If this branch's tool schemas change after the app is created, refresh the app's actions or recreate the draft before testing; do not assume server changes are picked up automatically.

### Founder-research connector and export-card check

After deploying `codex/founder-research-export`, refresh or rescan the private PMM Career MCP connector. Confirm exactly these six founder tools are discovered:

```text
start_yc_founder_research
process_yc_founder_research
save_founder_profile_candidates
confirm_founder_profile_candidate
save_founder_outreach_batch
export_founder_research_workbook
```

Also confirm the private founder-research export card renders its run summary and **Download Excel** control. Do not expose, copy, log, screenshot, or paste a download capability while checking it. The card receives that capability privately; it is not part of model-visible output. The check is incomplete if a founder tool is missing, an unexpected founder tool appears, or the card/control is absent.

### Founder-research retention cleanup and rollback

Expired workbook artifacts and their download capabilities are invalid by design. Do not attempt to reuse an expired download URL, and do not delete private database rows manually. Creating a fresh export for the same owner and snapshot safely removes expired matching workbook/capability records transactionally; otherwise, use only the existing owner-scoped application maintenance path. Preserve the structured run, evidence, candidate-decision, and outreach history.

If a deployment must be rolled back, first take the service back to the last known-good service commit on the feature-release path and recheck `/health` and `/ready`. Do not roll back `main`. Only consider a database reversal after the service rollback has been reviewed and only through a separately reviewed, reversible migration plan; do not improvise SQL or erase structured history. Keep secrets out of logs and support material throughout rollback and cleanup.

This release requires encrypted, versioned LinkedIn scope evidence. After deployment, any existing connection without that scope evidence will intentionally show as invalid and must be re-authorized through the normal LinkedIn consent flow. Do not preserve, backfill, or fabricate scope evidence for a legacy credential; the provider must grant it again.

## 7. Verify the morning and interactive boundaries

Use this exact schedule instruction:

> Research today's approved PMM topic and save a private LinkedIn draft in PMM
> Career MCP. Use the active PMM FIELD NOTES brand profile. Create a short,
> curiosity-driven cover hook that does not explain the post. Save a branded
> visual brief and render one private editorial cover. If metaphor source-image
> generation is unavailable in this scheduled run, save the brief and stop.
> Do not create an exact preview, do not upload anything to LinkedIn, and do not
> publish. Notify me when the private draft is ready, then stop.

The two supported Brand Studio sequences are:

```text
Statement: draft → brief → render → open review card
Metaphor: draft → brief → ChatGPT image → render with source → open review card
```

The scheduled flow may research, draft, save a branded visual brief, render one private editorial cover, save immutable versions, open the non-writing review-card boundary, and notify the user. It must finish with zero exact-preview rows and zero LinkedIn initialize, upload, or final-post calls. Only the final branded PNG is attached to the post draft; metaphor source art remains private and is never attached or published.

Scheduled image handoff is a capability gate, not a reason to add credentials. If the scheduled ChatGPT environment cannot hand a generated metaphor source image to the MCP file parameter, save the text draft plus the branded visual brief and stop. Generate or upload the source image later in the interactive conversation. Do not add an OpenAI API key, paid image service, Supabase service-role key, or Supabase secret key.

Every new initial draft, including a text-only draft with no images, uses the versioned whole-post checksum and can enter exact review directly. Drafts stored before that checksum remain readable but cannot enter exact review; use `revise_post` to create a new immutable current-format version first. Any later text, visibility, image bytes, order, MIME type, or alt-text change also requires a new version and a new exact preview.

Before requesting permission to enable either publishing switch, complete these checks in order:

1. Create the private `linkedin-draft-media` bucket with the exact settings in section 2 and apply the reviewed database and Storage RLS migrations as owner.
2. Deploy only `codex/supabase-migration`, with both switches false.
3. Attach a harmless private image through the authenticated ChatGPT connector to prove the custom-audience user JWT passes owner-folder Storage RLS. If it fails, stop; never add a service-role/secret key.
4. Refresh the ChatGPT app and verify the model-visible/app-only split above.
5. Run the morning schedule smoke. Confirm the private draft exists and that no preview row or LinkedIn call exists.
6. Interactively create an exact preview. With both switches still false, confirm publish is rejected before any LinkedIn request.
7. Report the evidence and obtain explicit user approval before changing either switch. A first live post still requires a new exact preview, inspection of the locked card, explicit confirmation, and one deliberate publish attempt.

The publish state machine does not automatically retry. `media_upload_failed` and `publish_failed` are definite terminal failures. `media_upload_unknown` and `publish_unknown` are terminal ambiguous outcomes. For `publish_unknown`, manually inspect the connected member's LinkedIn activity before creating a new draft version or attempt; the original capability is consumed and must never be retried.

## Failure diagnostics

| Symptom | Safe diagnosis |
| --- | --- |
| `/health` fails | Confirm the Railway process started and the public domain routes to the current deployment. Do not treat it as a database test. |
| `/ready` returns unavailable or Railway is unhealthy | Check migration/startup logs and both Railway database secret configurations. Do not copy database errors or either URL into chat. |
| OAuth discovery or consent fails | Recheck `SUPABASE_URL`, the derived issuer, Site URL, Authorization Path `/oauth/consent`, OAuth 2.1/DCR settings, and `openid`/`email` scopes. |
| Token is rejected | Run the private token verifier. Confirm the mandatory hook is enabled and check the exact issuer, canonical `BASE_URL` audience, expiry, one allowed subject, and `openid email` scopes. Do not bypass a mismatch. |
| ChatGPT cannot initialize `/mcp` | Confirm the HTTPS connector URL, successful OAuth consent, protected-resource metadata, and a healthy `/ready` endpoint. |
| Scheduled run cannot pass a generated image file | Save the text draft plus a branded visual brief and stop. Continue interactively; do not add an API key. |
| `publish_unknown` | Do not retry. Inspect LinkedIn manually for the exact content before creating a new version and preview. |
| Any secret appears in output | Revoke or rotate it using the provider, remove it from the exposed location, and repeat only the affected validation. |

Do not mark the production deployment complete until the live smoke, OAuth audience, Railway readiness, private Storage/JWT gate, ChatGPT connector refresh, morning boundary, and disabled-switch checks above have all succeeded with both publishing switches false.
