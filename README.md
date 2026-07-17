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

The server creates and migrates the SQLite database at `DATABASE_PATH` on startup. For local development, `AUTH_MODE=none` is allowed only outside production and publishing stays off by default.

## Host and connect ChatGPT

Production needs an HTTPS hostname, a persistent volume mounted at `/app/data`, and a real OAuth provider. Build and run the container with a persistent data directory:

```bash
docker build -t career-mcp:local .
docker run --rm -p 3000:3000 --env-file .env -v "$(pwd)/data:/app/data" career-mcp:local
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
- The only external write is a text post through LinkedIn's official API. Drafting, previews, shortlists, targets, and notes stay private in the SQLite volume.
- A failed or unknown publish attempt is not permission to retry automatically. Resolve it deliberately and create a fresh preview when needed.
