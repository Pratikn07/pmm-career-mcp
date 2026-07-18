# LinkedIn Web OAuth Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invalid LinkedIn hybrid web/PKCE request with LinkedIn's documented confidential web-server authorization-code flow.

**Architecture:** Keep the existing server-side LinkedIn OAuth component, HTTPS callback, extended login, encrypted storage, and short-lived single-use CSRF state. Remove only the native-PKCE verifier/challenge state and parameters from the LinkedIn authorization and token requests, then deploy the reviewed branch and complete one fresh user-controlled authorization.

**Tech Stack:** TypeScript 7, Vitest 4, Node.js URL API, LinkedIn OAuth 2.0 confidential web flow, GitHub, Railway.

## Global Constraints

- Keep LinkedIn scopes exactly `openid profile w_member_social`.
- Keep `enable_extended_login=true`.
- Keep the callback route and configured HTTPS redirect URI unchanged.
- Keep 32-byte random base64url state, ten-minute expiry, delete-before-network consumption, and replay rejection.
- Keep the LinkedIn client secret server-side and in the token request; never place it in the browser URL.
- Do not expose provider errors, authorization codes, tokens, credentials, or state values in output or logs.
- Do not modify the Supabase/ChatGPT-to-MCP OAuth flow.
- Keep `LINKEDIN_PUBLISH_ENABLED=false`; never publish without an explicit user request.
- Commit, push, and deploy only `codex/supabase-migration`; do not deploy `main`.

---

## File structure

- Modify `tests/linkedin/oauth.test.ts`: specify the standard confidential web authorization URL and exact token form.
- Modify `src/linkedin/oauth.ts`: remove only LinkedIn-native PKCE state and request parameters.
- No configuration, callback, database, migration, encryption, identity, MCP schema, or publishing files change.

### Task 1: Use LinkedIn's confidential web OAuth request

**Files:**
- Modify: `tests/linkedin/oauth.test.ts:1-102`
- Modify: `src/linkedin/oauth.ts:1-142`

**Interfaces:**
- Consumes: `createLinkedInOAuth(database, dependencies)`, `createAuthorizationUrl(): string`, and `exchangeCallback(input): Promise<{ connected: true }>`.
- Produces: the same public interfaces, with standard LinkedIn web-flow requests and unchanged state/storage behavior.

- [ ] **Step 1: Write failing authorization and token-form expectations**

In `tests/linkedin/oauth.test.ts`, remove the unused `createHash` import and rename the first test:

```ts
it("creates a confidential web authorization URL with extended login and no native PKCE fields", () => {
```

Replace its PKCE expectations with:

```ts
expect(url.searchParams.get("code_challenge")).toBeNull();
expect(url.searchParams.get("code_challenge_method")).toBeNull();
expect(url.searchParams.get("code_verifier")).toBeNull();
```

In the successful exchange test, replace the token-form assertion with an exact object and an explicit absence assertion:

```ts
expect(Object.fromEntries(form)).toEqual({
  grant_type: "authorization_code",
  code: "authorization-code",
  redirect_uri: "https://career.example.com/linkedin/callback",
  client_id: "client-id",
  client_secret: "client-secret"
});
expect(form.has("code_verifier")).toBe(false);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/linkedin/oauth.test.ts
```

Expected: the authorization URL test fails because `code_challenge` and `code_challenge_method` are present, and the exchange test fails because the token form contains `code_verifier`. The remaining state and provider tests pass.

- [ ] **Step 3: Implement the minimal web-flow correction**

In `src/linkedin/oauth.ts`:

1. Replace the crypto import with:

```ts
import { randomBytes as nodeRandomBytes } from "node:crypto";
```

2. Replace the pending-state type with:

```ts
type PendingState = Readonly<{ expiresAt: number }>;
```

3. In `createAuthorizationUrl()`, retain only state generation and validation:

```ts
const now = currentTime(clock);
const state = randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
  throw new DomainError("DATA_INTEGRITY", "OAuth random source returned an invalid value");
}
pendingStates.set(state, { expiresAt: now + OAUTH_STATE_TTL_MS });
```

4. Keep the authorization parameters through `state`, but remove both PKCE assignments so the block ends:

```ts
url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
url.searchParams.set("state", state);
return url.href;
```

5. Keep the confidential token form through `client_secret` and remove only `code_verifier`:

```ts
body: new URLSearchParams({
  grant_type: "authorization_code",
  code: input.code,
  redirect_uri: dependencies.redirectUri,
  client_id: dependencies.clientId,
  client_secret: dependencies.clientSecret
}).toString()
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/linkedin/oauth.test.ts
```

Expected: all LinkedIn OAuth tests pass with zero failures.

- [ ] **Step 5: Run complete verification**

Run each command independently:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 638 tests pass with zero failures, typecheck exits 0, build exits 0, and the diff check reports no errors.

- [ ] **Step 6: Review exact scope**

Run:

```bash
git diff -- tests/linkedin/oauth.test.ts src/linkedin/oauth.ts
```

Expected: only the test expectations and LinkedIn-native PKCE import/state/parameters are removed. Extended login, scopes, callback inputs, client secret, state expiry/consumption, provider handling, identity lookup, encryption, and storage remain unchanged.

- [ ] **Step 7: Commit the implementation**

```bash
git add tests/linkedin/oauth.test.ts src/linkedin/oauth.ts
git commit -m "fix: use LinkedIn confidential web OAuth flow"
```

Expected: one implementation commit containing only the two intended files.

### Task 2: Deploy and complete live authorization

**Files:**
- No source files modified.

**Interfaces:**
- Consumes: the reviewed `codex/supabase-migration` head and existing Railway service `pmm-career-mcp`.
- Produces: a healthy deployment and a user-authorized, valid LinkedIn connection with publishing disabled.

- [ ] **Step 1: Confirm branch and push**

Run:

```bash
git status --short --branch
git log -4 --oneline
git show --stat --oneline HEAD
git push github codex/supabase-migration
```

Expected: the branch is `codex/supabase-migration`, the implementation commit contains only the intended source/test files, and GitHub advances only this deployment branch.

- [ ] **Step 2: Verify Railway deployed the reviewed head**

Poll:

```bash
railway deployment list --service pmm-career-mcp --environment production --json
```

Expected: the newest deployment reaches `SUCCESS`, names `codex/supabase-migration`, and reports the exact local `git rev-parse HEAD` hash. If GitHub does not trigger a deployment, deploy the verified checkout with:

```bash
railway up --service pmm-career-mcp --environment production --detach --json --message "deploy $(git rev-parse HEAD)"
```

- [ ] **Step 3: Verify endpoints and publishing lock**

Run:

```bash
curl -fsS --max-time 20 https://pmm-career-mcp-production.up.railway.app/health
curl -fsS --max-time 20 https://pmm-career-mcp-production.up.railway.app/ready
```

Expected: `{"status":"ok"}` and `{"status":"ready"}`.

Parse Railway production variables in memory and print only:

```text
LINKEDIN_CLIENT_ID_present=true
LINKEDIN_CLIENT_SECRET_present=true
LINKEDIN_REDIRECT_URI_present=true
LINKEDIN_PUBLISH_ENABLED_is_false=true
```

- [ ] **Step 4: Create and complete a fresh user authorization**

In ChatGPT, request:

```text
Use PMM Career MCP's create_linkedin_authorization_url action. Do not create, preview, or publish any content.
```

Open the new URL promptly, use Google sign-in, approve PMM Career MCP, and wait for:

```text
LinkedIn is connected. You can close this window.
```

Do not reuse or share a prior URL, state, callback URL, authorization code, or token.

- [ ] **Step 5: Verify the live connection and publishing lock**

In ChatGPT, request:

```text
Use PMM Career MCP to check my LinkedIn connection status. Do not publish anything.
```

Expected: connected `Yes`, valid `Yes`, publishing enabled `No`.
