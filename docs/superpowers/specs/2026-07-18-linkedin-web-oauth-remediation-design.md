# LinkedIn Web OAuth Remediation Design

## Context

PMM Career MCP currently sends LinkedIn a hybrid OAuth request: it uses LinkedIn's confidential web-server authorization endpoint and HTTPS Railway callback while also adding PKCE parameters documented for LinkedIn's separate native-client flow.

A live authorization established that LinkedIn login and consent succeeded, the callback returned to the same Railway deployment instance 17 seconds after the MCP generated the URL, and the callback then returned HTTP 400. This rules out the ten-minute state expiry and a deployment-instance change. The remaining callback path begins with the token exchange, where the implementation currently sends both a confidential-client secret and a native-flow code verifier.

LinkedIn documents the standard web-server token exchange with `grant_type`, `code`, `client_id`, `client_secret`, and `redirect_uri`. It documents PKCE on a different authorization endpoint for native applications, requires a loopback redirect, and requires LinkedIn to enable that flow for the application.

## Goal

Use LinkedIn's documented confidential web-server authorization-code flow so PMM Career MCP can exchange an approved authorization code, store the resulting LinkedIn token securely, and report a valid connection.

## Superseded assumption

This design supersedes only the LinkedIn PKCE-preservation requirement in `2026-07-18-linkedin-extended-login-design.md`. The extended-login behavior remains required. PMM Career MCP's separate ChatGPT-to-MCP OAuth flow and its PKCE requirements are unchanged.

## Non-goals

- Do not change LinkedIn scopes: `openid profile w_member_social`.
- Do not change the HTTPS callback route or registered redirect URI.
- Do not change encrypted token storage, identity lookup, post drafting, previews, or publishing.
- Do not enable LinkedIn publishing; production must retain `LINKEDIN_PUBLISH_ENABLED=false`.
- Do not expose provider errors, authorization codes, tokens, credentials, or state values to the browser or logs.
- Do not modify the Supabase OAuth flow protecting the MCP endpoint.

## Considered approaches

1. **Use LinkedIn's confidential web-server flow (selected).** Remove LinkedIn PKCE fields while retaining the client secret, HTTPS redirect, short-lived single-use state, and extended login. This matches the registered application and deployed callback.
2. Use LinkedIn's native PKCE flow. This requires a separate native authorization endpoint, a loopback callback, and provider enablement, so it is incompatible with the hosted Railway server.
3. Keep the hybrid flow and add diagnostics or retries. This would retain the protocol mismatch, and retries would be unsafe because authorization codes and state are single-use.

## Design

### Pending authorization state

The in-memory pending-state map will store only `expiresAt`. Each authorization request will continue to generate a 32-byte random base64url state, validate its format, retain it for ten minutes, delete it before any token-network operation, and reject missing, unknown, expired, or reused state.

### Authorization request

`createAuthorizationUrl()` will continue to generate:

- `response_type=code`
- `enable_extended_login=true`
- configured `client_id`
- configured HTTPS `redirect_uri`
- exact scopes `openid profile w_member_social`
- random single-use `state`

It will no longer send `code_challenge` or `code_challenge_method`. It will never place the client secret in the browser URL.

### Token exchange

`exchangeCallback()` will send exactly the confidential web-flow fields LinkedIn documents:

- `grant_type=authorization_code`
- the callback `code`
- the same configured `redirect_uri`
- configured `client_id`
- configured `client_secret`

It will not send `code_verifier`. Provider failures remain generic to the browser and do not expose response bodies.

### Identity and storage

After a successful token exchange, the existing user-info request, identity validation, encrypted token storage, expiration calculation, optional encrypted refresh metadata, and author URN construction remain unchanged.

## Security properties

- CSRF protection remains through 256-bit random, short-lived, single-use state.
- Authorization codes are consumed once and exchanged only by the server.
- The confidential client secret remains server-side in Railway.
- The callback remains an exact registered HTTPS URI.
- LinkedIn access and refresh tokens remain encrypted before database storage.
- Publishing remains disabled independently of connection status.
- A failed or shared authorization URL must be discarded; the MCP must create a fresh one.

## Testing

The existing LinkedIn OAuth test will be updated through TDD to verify:

1. The authorization URL retains endpoint, response type, extended login, client ID, redirect URI, exact scopes, and random state.
2. `code_challenge`, `code_challenge_method`, and `code_verifier` are absent from the browser URL.
3. The token request retains the client secret and documented web-flow fields.
4. `code_verifier` is absent from the token request.
5. Missing, expired, and reused state continue to fail before additional provider calls.
6. Successful tokens and identity are still encrypted and stored without returning credentials.

The focused LinkedIn OAuth tests must demonstrate the old hybrid behavior failing before the production change, then pass afterward. The full test suite, typecheck, build, and diff check must pass.

## Deployment and live verification

Commit and push only `codex/supabase-migration`; do not deploy `main`. Confirm Railway deploys the exact reviewed head, `/health` and `/ready` succeed, LinkedIn configuration remains present without printing its values, and `LINKEDIN_PUBLISH_ENABLED` remains exactly `false`.

The user must then create a fresh authorization URL in ChatGPT, use Google sign-in, approve PMM Career MCP, and reach `LinkedIn is connected. You can close this window.` A final read-only MCP check must report connected `Yes`, valid `Yes`, and publishing enabled `No`.

## Success criteria

The live LinkedIn callback succeeds with the documented confidential web-server flow, encrypted credentials are stored server-side, the MCP reports a valid connection, and publishing remains disabled.
