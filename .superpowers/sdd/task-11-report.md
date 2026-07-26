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

## Review fixes

### Corrections

- Replaced semantic `URL`/`searchParams` validation with exact raw-string grammar validation. The private URL must exactly equal the canonical configured application origin, exact export download path, literal `?capability=`, and a 43-character base64url token. Trailing delimiters and percent-encoded token characters now fail closed.
- Added an injectable, cancellable `scheduleExpiry` dependency. On activation, the controller schedules fail-closed disabling at the earlier of the export and capability expiries; expiry clears the active URL and disables the button without a click.
- Added an independent test where `toolOutput` remains valid while `mcp_tool_result.structuredContent` carries an unsafe substituted URL. The strict canonical-envelope equality check prevents activation.
- Extended the static-client test to scan the shipped `dist/public/founder-export-card-client.js` bundle for both `callTool` and `linkedin`, as well as the source-level check.

### RED

Before changing the controller, `npx vitest run tests/founder-export-card/controller.test.ts` failed as expected: 1 file, 3 failed / 10 passed tests. The relevant failures were the trailing query delimiter and percent-encoded capability cases (each received enabled `true` rather than disabled `false`) and the expiry case (the scheduler was called zero times rather than once). The explicit structured-content substitution test already passed on the prior strict binding behavior; the focused RED nevertheless proved the two reviewed behavior gaps before production code changed.

### GREEN and verification

- `npx vitest run tests/founder-export-card/controller.test.ts` — passed: 1 file / 13 tests.
- `npm run build` — passed.
- `npx vitest run tests/founder-export-card tests/http/founder-export-card-client.test.ts tests/build/dockerfile.test.ts` — passed: 4 files / 29 tests.
- `npm run typecheck` — passed.
- `npm audit --omit=dev` — passed: `found 0 vulnerabilities`.
- `git diff --check` — passed with no whitespace errors.

### Files changed for review fixes

- `src/founder-export-card/controller.ts`
- `tests/founder-export-card/controller.test.ts`
- `tests/http/founder-export-card-client.test.ts`
- `.superpowers/sdd/task-11-report.md`

### Self-review

The raw URL is now accepted only if its byte-for-byte spelling is canonical; no URL parser normalization can widen that acceptance. The timer callback clears the active private URL before disabling the UI, while normal invalid click handling cancels any pending timer. Timer setup is dependency-injected for deterministic tests and is fail-closed if the scheduler throws. The pre-existing progress file was not modified or staged.

## Final review fixes

### Corrections and integration rationale

- Replaced browser `window.open` navigation with the hosted ChatGPT bridge contract: `window.openai.openExternal({ href: validatedUrl, redirectUrl: false })`. The false redirect flag is intentional so the host cannot append or mutate query data containing the private download capability.
- Added the canonical application origin as the sole legacy `openai/widgetCSP.redirect_domains` entry on both the registered resource descriptor and returned resource contents. The standard `ui.csp` remains unchanged.
- Made navigation asynchronous and fail closed. Missing `openExternal`, synchronous throws, and rejected promises clear the active URL, cancel its timer, disable the button, and show only the safe unavailable state. There is no `window.open` fallback.
- Rejected `mcp_tool_result.isError` whenever present and not exactly `false`, while retaining compatibility with the expected success envelope where the field is absent.

### RED

Before production changes, `npx vitest run tests/founder-export-card tests/http/founder-export-card-client.test.ts` failed as expected: 3 files failed, 8 tests failed, and 17 passed. Relevant failures were:

- the exact `openExternal({ href, redirectUrl: false })` assertion received zero calls;
- `isError:true` left availability enabled (`true` instead of `false`);
- missing, throwing, and rejecting `openExternal` each left availability enabled;
- the expected `redirect_domains` entry was absent;
- source and shipped bundle still lacked `openExternal` and contained the old navigation implementation.

These failures directly demonstrated both requested blockers before production code changed.

### GREEN and final verification

- `npx vitest run tests/founder-export-card` — passed: 2 files / 22 tests.
- `npm run build` — passed, including the rebuilt founder export card bundle.
- `npx vitest run tests/founder-export-card tests/http/founder-export-card-client.test.ts tests/build/dockerfile.test.ts` — passed: 4 files / 33 tests.
- `npm run typecheck` — passed.
- `npm audit --omit=dev` — passed: `found 0 vulnerabilities`.
- `git diff --check` — passed with no whitespace errors.

### Files changed

- `src/founder-export-card/client.ts`
- `src/founder-export-card/controller.ts`
- `src/founder-export-card/resource.ts`
- `tests/founder-export-card/controller.test.ts`
- `tests/founder-export-card/resource.test.ts`
- `tests/http/founder-export-card-client.test.ts`
- `.superpowers/sdd/task-11-report.md`

### Self-review

The controller is the single policy boundary for private navigation: it supplies the exact two-field bridge request only after all origin/path/query, envelope, correlation, and expiry checks pass. Every bridge-unavailable or bridge-failure path clears capability-bearing state before updating the UI. Resource tests verify the redirect allowlist at both metadata surfaces, while behavior tests verify exact bridge arguments and all fail-closed outcomes. Source and rebuilt-bundle checks independently confirm there is no `window.open` fallback. `.superpowers/sdd/progress.md` remains untouched and unstaged.
