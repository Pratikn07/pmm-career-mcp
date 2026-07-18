# LinkedIn Extended Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LinkedIn's Google, Apple, and passkey sign-in methods available when ChatGPT opens PMM Career MCP's LinkedIn authorization URL.

**Architecture:** Preserve the existing server-side authorization-code flow, in-memory state, PKCE, callback, encrypted token storage, scopes, and publishing lock. Change only the LinkedIn authorization URL builder to include LinkedIn's documented `enable_extended_login=true` query parameter, prove it with a focused regression test, then deploy the verified branch to the existing Railway service.

**Tech Stack:** TypeScript 7, Vitest 4, Node.js URL API, LinkedIn OAuth 2.0 authorization-code flow with PKCE, GitHub, Railway.

## Global Constraints

- Keep the LinkedIn scope set exactly `openid profile w_member_social`.
- Keep `LINKEDIN_PUBLISH_ENABLED=false` in Railway production.
- Do not change the callback route, token exchange, PKCE, state validation, or encrypted token storage.
- Never print or commit LinkedIn credentials, database URLs, passwords, OAuth codes, tokens, or encryption keys.
- Commit and deploy only `codex/supabase-migration`; do not deploy `main`.
- A post must never be published without the user's explicit request.

---

## File structure

- Modify `tests/linkedin/oauth.test.ts`: assert the generated authorization URL opts into LinkedIn extended login.
- Modify `src/linkedin/oauth.ts`: add the single documented authorization query parameter.
- No database, migration, configuration schema, callback, token, MCP schema, or publishing file changes are required.

### Task 1: Generate an extended-login LinkedIn authorization URL

**Files:**
- Modify: `tests/linkedin/oauth.test.ts:35-53`
- Modify: `src/linkedin/oauth.ts:101-109`

**Interfaces:**
- Consumes: `createLinkedInOAuth(database, dependencies)` and its existing `createAuthorizationUrl(): string` return value.
- Produces: the same `createAuthorizationUrl(): string` interface, with the additional query parameter `enable_extended_login=true`.

- [ ] **Step 1: Write the failing regression assertion**

Add this assertion beside the existing response-type assertion in `tests/linkedin/oauth.test.ts`:

```ts
expect(url.searchParams.get("enable_extended_login")).toBe("true");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/linkedin/oauth.test.ts
```

Expected: the authorization URL test fails because `url.searchParams.get("enable_extended_login")` is `null`, while the other LinkedIn OAuth tests pass.

- [ ] **Step 3: Add the minimal production change**

Add this line immediately after `response_type` is set in `src/linkedin/oauth.ts`:

```ts
url.searchParams.set("enable_extended_login", "true");
```

The resulting parameter block must begin:

```ts
const url = new URL(AUTHORIZATION_ENDPOINT);
url.searchParams.set("response_type", "code");
url.searchParams.set("enable_extended_login", "true");
url.searchParams.set("client_id", dependencies.clientId);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run tests/linkedin/oauth.test.ts
```

Expected: all tests in `tests/linkedin/oauth.test.ts` pass with zero failures.

- [ ] **Step 5: Run complete local verification**

Run each command independently:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: the full Vitest suite passes with zero failures, typecheck exits 0, build exits 0, and `git diff --check` reports no errors.

- [ ] **Step 6: Review the exact code diff**

Run:

```bash
git diff -- tests/linkedin/oauth.test.ts src/linkedin/oauth.ts
```

Expected: one new test assertion and one new URL parameter assignment, with no changes to scopes, state, PKCE, callback handling, tokens, or publishing.

- [ ] **Step 7: Commit the implementation**

```bash
git add tests/linkedin/oauth.test.ts src/linkedin/oauth.ts
git commit -m "fix: enable LinkedIn extended login"
```

Expected: a new commit on `codex/supabase-migration` containing only the two intended files.

### Task 2: Publish and verify the production remediation

**Files:**
- No source files modified.

**Interfaces:**
- Consumes: the verified `codex/supabase-migration` implementation commit and existing Railway service `pmm-career-mcp`.
- Produces: a healthy production deployment that generates LinkedIn authorization URLs with extended login enabled while publishing remains disabled.

- [ ] **Step 1: Confirm branch and commit scope**

Run:

```bash
git status --short --branch
git log -3 --oneline
git show --stat --oneline HEAD
```

Expected: branch is `codex/supabase-migration`; only the known unrelated untracked `.superpowers/sdd/task-3a-review.md` may remain; the implementation commit contains only `tests/linkedin/oauth.test.ts` and `src/linkedin/oauth.ts`.

- [ ] **Step 2: Push the deployment branch**

Run:

```bash
git push github codex/supabase-migration
```

Expected: GitHub advances `Pratikn07/pmm-career-mcp` branch `codex/supabase-migration` to the implementation commit.

- [ ] **Step 3: Confirm or initiate the Railway deployment**

Run:

```bash
railway deployment list --service pmm-career-mcp --environment production --json
```

If Railway has not created a deployment for the new GitHub commit after the push, upload the verified checkout explicitly and attach the commit hash to the deployment message:

```bash
railway up --service pmm-career-mcp --environment production --detach --json --message "deploy $(git rev-parse HEAD)"
```

Expected: a GitHub-triggered deployment names branch `codex/supabase-migration` and reports the exact implementation commit hash; a CLI fallback deployment carries that exact hash in its deployment message. In either case, the newest deployment reaches `SUCCESS`.

- [ ] **Step 4: Verify live health and readiness**

Run:

```bash
curl -fsS --max-time 20 https://pmm-career-mcp-production.up.railway.app/health
curl -fsS --max-time 20 https://pmm-career-mcp-production.up.railway.app/ready
```

Expected: `{"status":"ok"}` and `{"status":"ready"}`.

- [ ] **Step 5: Verify production configuration without exposing values**

Read `railway variable list --service pmm-career-mcp --environment production --json` into an in-memory parser and print only these booleans:

```text
LINKEDIN_CLIENT_ID_present=true
LINKEDIN_CLIENT_SECRET_present=true
LINKEDIN_REDIRECT_URI_present=true
LINKEDIN_PUBLISH_ENABLED_is_false=true
```

Expected: all four booleans are `true`; no credential values appear in terminal or chat output.

- [ ] **Step 6: Complete the live user authorization check**

In ChatGPT, request:

```text
Use PMM Career MCP's create_linkedin_authorization_url action. Do not create, preview, or publish any content.
```

Generate a new URL after deployment. Confirm it contains `enable_extended_login=true`, then open it promptly, select Google sign-in, authorize `PMM Career MCP`, and wait for the callback message `LinkedIn is connected. You can close this window.` Do not share the URL, state, authorization code, or token.

- [ ] **Step 7: Verify connection status and publishing lock**

In ChatGPT, request:

```text
Use PMM Career MCP to check my LinkedIn connection status. Do not publish anything.
```

Expected: connected `Yes`, valid `Yes`, publishing enabled `No`.
