# PMM Career MCP

A private, single-user MCP server for YC-company career research, a networking pipeline, and deliberately controlled LinkedIn drafting with zero to four images. It is designed for ChatGPT Developer Mode. It does not scrape LinkedIn, send LinkedIn messages, make connection requests, or post from a scheduled/model-driven run. Publishing is available only through the human-operated review card after an exact preview and explicit final confirmation.

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

Production needs an HTTPS hostname, a TLS-enabled least-privilege Supabase PostgreSQL `DATABASE_URL`, a distinct owner-only `MIGRATION_DATABASE_URL`, the project CA PEM in `DATABASE_CA_CERT`, and `AUTH_MODE=oauth`. The CA enables full certificate and hostname verification for both migration and runtime pools. The container is stateless:

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

## Guarded LinkedIn workflow

Both publishing switches default to `false` and stay false through local verification, deployment, connector refresh, the scheduled-flow smoke, and the disabled-publish smoke:

- `LINKEDIN_PUBLISH_ENABLED` is the master switch. When false, every text or image publish attempt is rejected before LinkedIn.
- `LINKEDIN_IMAGE_PUBLISH_ENABLED` independently controls image upload/publishing. An image post requires both switches; a text-only post still requires the app-only exact-preview flow and the master switch.

Enabling either switch never authorizes a post. There is no unattended posting, automatic retry, LinkedIn messaging, or connection-request capability.

Only after the private deployment and read-only MCP flow are working should an operator create a LinkedIn app, set the host-only (non-secret) `LINKEDIN_REDIRECT_URI` to `https://your-host.example/linkedin/callback`, and add the LinkedIn client values plus a 64-character hexadecimal `TOKEN_ENCRYPTION_KEY` to the host's secret store. Leave the redirect URI unset before that later phase. Tokens are encrypted in managed PostgreSQL and are never returned by MCP tools.

After deploying this version, any legacy LinkedIn connection without encrypted, versioned scope evidence will appear invalid and must be re-authorized through the normal LinkedIn consent flow. Do not preserve, backfill, or fabricate scope evidence for an older token.

The model-visible tools may research, save or revise a private draft, attach or reorder one to four validated images, update alt text, list history, and open the non-writing review card. `create_exact_linkedin_preview` and `publish_exact_linkedin_post` are app-only actions hidden from the model. Opening the card is not approval, and creating an exact preview is not publishing. Every real post requires the exact immutable text, visibility, image order, alt text, checksums, a fresh one-use capability, and a final human confirmation in the card.

Every newly created draft, including its first text-only version, uses the whole-post checksum format and can enter exact review without a forced revision. Drafts stored before that format remain readable, but exact review rejects them; revise a legacy draft to create a new immutable current-format version before opening an exact preview.

Use this exact instruction for the morning ChatGPT schedule:

> Research today's approved topic and save a private LinkedIn draft in PMM Career MCP. You may prepare up to four draft images with alt text. Do not create an exact preview, do not upload anything to LinkedIn, and do not publish. Notify me when the private draft is ready, then stop.

If a scheduled ChatGPT run cannot pass a generated image file to the MCP, it must save the text draft plus a detailed image brief and stop. Generate or upload the image later in the interactive conversation. Do not add an OpenAI API key, paid image service, or secret Supabase key as a workaround.

Publishing uses one deliberate, no-retry attempt. `media_upload_failed` and `publish_failed` are definite terminal failures; create a new draft version and exact preview before another deliberate attempt. `media_upload_unknown` and `publish_unknown` are terminal ambiguous states. For `publish_unknown`, inspect LinkedIn manually before doing anything else—never retry the same capability.

## Operating rules

- Never paste client secrets, access tokens, refresh tokens, encryption keys, OAuth states, database URLs, or `.env` contents into ChatGPT.
- Research is limited to YC companies and allowed public company sources; people coverage is best-effort, never a complete directory.
- YC company discovery uses an official server-rendered YC industry or location facet page selected from the query. Every MCP response includes a page-scoped coverage summary—even when no company matches—so an empty result is never presented as proof of complete YC-wide coverage.
- Networking scores are calculated on the server from bounded person, source-evidence, opportunity, preference, and weight inputs. Ranking, explanation, and persistence never accept caller-authored numeric scores, and saving recalculates the score immediately before the private database write.
- Every tool returns a typed success payload or a safe error code plus a short non-secret summary. Approval capabilities remain widget-private, and authorization URLs are not copied into summary text.
- Drafts, previews, shortlists, targets, and notes stay private in the managed database.
- A failed or unknown publish attempt is not permission to retry automatically. Resolve it deliberately and create a fresh preview when needed.

## Verification status

Local automated checks cover the database migration path, OAuth validation, request-scoped private-media composition, scheduled-flow boundary, readiness behavior, and publishing safety. A production deployment is not verified until the operator completes the runbook's live Supabase Storage/JWT gate, OAuth audience, Railway readiness, ChatGPT connector, morning-schedule, and disabled-switch checks with both publishing switches false.
