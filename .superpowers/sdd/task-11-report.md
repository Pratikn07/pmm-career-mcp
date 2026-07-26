# Task 11 report — private founder workbook export card

## Implementation

Added a private ChatGPT resource at
`ui://pmm-career-mcp/founder-export-card.html` with a single **Download Excel**
button and a safe summary containing only the run ID, creation time, export
expiry, workbook row/sheet count, and a 12-character checksum prefix.

The card client:

- reads the safe display projection from `window.openai.toolOutput`;
- accepts the raw download URL only from
  `window.openai.toolResponseMetadata.mcp_tool_result._meta` after strict
  canonical-envelope binding to the safe projection;
- requires private metadata shaped exactly as `{ downloadUrl, expiresAt }`;
- accepts only the configured canonical HTTPS application origin and the exact
  `/research-exports/:exportId/download?capability=<43-character-base64url>`
  route, with no credentials, fragment, alternate export ID, duplicate, or
  extra query parameter;
- rejects unavailable, expired, malformed, mismatched, and later substituted
  global data without opening a URL;
- locks the first valid metadata snapshot and disables the button when either
  the artifact or capability is expired;
- uses `textContent` and DOM properties for every displayed value, with no
  HTML injection path, tool invocation, network fetch, or LinkedIn action.

The resource has an exact one-origin widget domain and CSP. The app serves the
bundled client at `/founder-export-card-client.js` with `Cache-Control:
no-cache` and `X-Content-Type-Options: nosniff`. The production build and
Docker checks now include the bundle.

## Files

- Added `src/founder-export-card/resource.ts`
- Added `src/founder-export-card/controller.ts`
- Added `src/founder-export-card/client.ts`
- Added `scripts/build-founder-export-card.mjs`
- Added `tests/founder-export-card/resource.test.ts`
- Added `tests/founder-export-card/controller.test.ts`
- Added `tests/http/founder-export-card-client.test.ts`
- Updated `src/http/app.ts`, `package.json`, `Dockerfile`, and
  `tests/build/dockerfile.test.ts`

## Test-driven development evidence

### RED

Command run before any production card code:

```text
npx vitest run tests/founder-export-card
```

Expected failing result:

```text
Test Files  2 failed (2)
Tests  no tests
Cannot find module '../../src/founder-export-card/controller.js'
Cannot find module '../../src/founder-export-card/resource.js'
```

This was the intended RED: both contract suites imported production modules
that did not yet exist. No production card file had been created at that point.

### GREEN

Focused Task 11 command:

```text
npx vitest run tests/founder-export-card
```

Result:

```text
Test Files  2 passed (2)
Tests       14 passed (14)
```

Expanded relevant client and Docker verification:

```text
npx vitest run tests/founder-export-card tests/http/founder-export-card-client.test.ts tests/build/dockerfile.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests       25 passed (25)
```

## Final verification

All commands were run in the isolated Task 11 worktree.

```text
npm run build
```

Passed: server compilation plus consent, existing review-card, and new
founder-export-card bundles.

```text
npm run typecheck
```

Passed (`tsc --noEmit`).

```text
npm audit --omit=dev
```

Passed: `found 0 vulnerabilities`.

```text
git diff --check
```

Passed with no whitespace errors.

## Self-review

- The resource interpolates only a prevalidated canonical HTTPS origin.
- The client does not contain `callTool`, LinkedIn logic, third-party URLs, or
  HTML-writing APIs.
- The controller distinguishes the safe model-visible summary from private
  metadata; a raw URL supplied through tool output or structured content cannot
  become active.
- The static route is a fixed `sendFile` from `dist/public` and has no cache or
  content-sniffing relaxation.
- The first valid private snapshot is immutable for the card lifetime, so a
  repeated globals event cannot swap its capability URL.

## Baseline-suite limitation

The complete `npm test` suite was not rerun for this task. The provided clean
baseline had already established that its build passed but ten unrelated
candidate/outreach tests fail because their fixed July 25 clocks precede rows
created by the current real clock on July 26 (1446 passed, 5 skipped). This
task neither modified nor attempted to fix those unrelated tests.

## Concerns

The later Task 12 tool registration must provide the safe export projection in
the exact `data.export` shape tested here and place only `{ downloadUrl,
expiresAt }` in the canonical `toolResponseMetadata` private metadata. The
raw capability remains embedded only in that private download URL. The
pre-existing `.superpowers/sdd/progress.md` change was left byte-for-byte
untouched and will remain unstaged.
