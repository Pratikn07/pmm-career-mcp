# LinkedIn Extended Login Design

## Context

PMM Career MCP creates a standards-based LinkedIn authorization URL with PKCE. When ChatGPT opens that URL, LinkedIn currently presents an email-and-password login form without the user's Google sign-in option, even though the user already accesses LinkedIn through Google.

LinkedIn's current authorization-code documentation states that OAuth requests opened from platforms such as native apps can enable Google, Apple, and passkey login by including `enable_extended_login=true` on the `/oauth/v2/authorization` request.

## Goal

Allow the LinkedIn authorization flow launched from ChatGPT to offer LinkedIn's supported extended login methods, including Google sign-in.

## Non-goals

- Do not change the requested LinkedIn scopes: `openid`, `profile`, and `w_member_social`.
- Do not change the callback route, token exchange, PKCE, state validation, or token storage.
- Do not enable LinkedIn publishing. `LINKEDIN_PUBLISH_ENABLED` must remain `false`.
- Do not collect, receive, or store the user's Google or LinkedIn password.

## Considered approaches

1. **Add `enable_extended_login=true` to the authorization URL (selected).** This is LinkedIn's documented mechanism, preserves the existing OAuth architecture, and requires one isolated behavior change.
2. Ask the user to copy each URL into an already authenticated browser profile. This requires no code change but is brittle across ChatGPT and browser session boundaries.
3. Ask the user to establish a separate LinkedIn password. This may work but adds unnecessary account-management burden and is not appropriate when LinkedIn supports the user's preferred login method directly.

## Design

`createLinkedInOAuth().createAuthorizationUrl()` will add the exact query parameter `enable_extended_login=true` to the existing LinkedIn authorization URL. All existing parameters remain unchanged:

- `response_type=code`
- configured `client_id`
- configured HTTPS `redirect_uri`
- fixed least-required scope set
- random, short-lived, single-use `state`
- PKCE `code_challenge` and `code_challenge_method=S256`

The MCP tool response remains a short-lived URL. The user must generate a fresh URL after deployment because OAuth state is held in memory for ten minutes and is single-use.

## Error handling and security

LinkedIn remains responsible for authentication and consent on `linkedin.com`. The MCP never receives login credentials. The callback continues to reject missing, expired, reused, or mismatched state and stores only encrypted LinkedIn token material after a successful authorization-code exchange.

Sharing an authorization URL should be avoided because it contains transient state. A shared or expired URL must be discarded and regenerated.

## Testing

A focused regression test will assert that every generated LinkedIn authorization URL contains `enable_extended_login=true`, while retaining the existing assertions for endpoint, client ID, redirect URI, scopes, state, and PKCE. The test must fail before the production change and pass afterward. The full automated test suite, typecheck, and build must also pass.

## Deployment and verification

The change will be committed and pushed only to `codex/supabase-migration`, then deployed to the existing Railway service. Verification must confirm:

1. Railway deployed the intended branch and commit successfully.
2. `/health` and `/ready` return successful responses.
3. LinkedIn configuration variables remain present without printing their values.
4. `LINKEDIN_PUBLISH_ENABLED` remains exactly `false`.
5. A newly generated authorization URL includes `enable_extended_login=true`.
6. The user can select Google sign-in or reuse a valid LinkedIn browser session, approve PMM Career MCP, reach the callback success page, and obtain a valid connected status while publishing remains disabled.

## Success criteria

The user completes LinkedIn authorization without providing credentials to PMM Career MCP, `check_linkedin_connection_status` reports connected and valid, and publishing remains disabled.
