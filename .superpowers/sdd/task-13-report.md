# Task 13 report — founder-research application composition and E2E

## Outcome

`createCareerApplication` now composes the previously implemented founder
research layers into the production application:

- run, candidate, outreach, and export services are created inside the
  stateless MCP factory from the authenticated request subject;
- each service receives the shared database and trusted application clock;
- the run service receives the persisted YC provider and hardened official-site
  people projection;
- the private export-card resource is registered through the MCP
  `founderResearch` dependency only when `BASE_URL` is an exact canonical HTTPS
  origin;
- the capability download service is created once at application scope for the
  configured private owner and its `download` function is injected into the
  existing HTTP application dependency.

The existing `src/http/app.ts` route and dependency seam already implemented
the capability boundary. It was deliberately left unchanged: the download
route remains outside `/mcp`, the OAuth middleware still runs before MCP JSON
parsing, and the MCP server lifecycle remains one fresh server per request with
exactly-once cleanup.

## Files

- Modified `src/index.ts`
- Modified `tests/runtime/async-composition.test.ts`
- Modified `tests/e2e/fixtures.ts`
- Added `tests/e2e/founder-research-flow.test.ts`
- Added `.superpowers/sdd/task-13-report.md`

No production fetcher, service contract, database schema, MCP schema, workbook
writer, export card, or HTTP security validation was weakened or expanded.

## Test-driven development evidence

### RED

Before any production file changed, the only worktree entries were the
pre-existing `.superpowers/sdd/progress.md` modification and the new/modified
Task 13 test files.

Exact command:

```text
npx vitest run tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts
```

Expected result:

```text
Test Files  2 failed (2)
Tests       2 failed | 10 passed (12)
```

The runtime composition test received `isError: true` from
`start_yc_founder_research`. The E2E received no `data.run`. Both failures were
the intended missing-composition signal: the six MCP tools existed, but
`createCareerApplication` had not injected founder services.

### GREEN

Exact Task 13 command:

```text
npx vitest run tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       13 passed (13)
```

The full two-company E2E proves:

1. a two-member private run starts;
2. one official-site founder/profile is `VERIFIED`;
3. one unresolved company produces a bounded public-search task;
4. a public-search candidate is saved with
   `linkedInNotFetched: true` while the official-page request allowlist remains
   unchanged;
5. the candidate is manually confirmed;
6. two separate immutable outreach drafts are saved at version 1;
7. the workbook export returns only its safe projection to model-visible
   content and places the capability URL only in private metadata;
8. the private export-card resource is opened and read at the exact canonical
   HTTPS application origin;
9. the HTTP capability route returns bytes exactly equal to the persisted
   workbook and its SHA-256 checksum;
10. the downloaded workbook reopens with CRC verification and exactly the four
    ordered sheets `Ready to Review`, `Needs Verification`,
    `Not Found - Failed`, and `Run Summary`;
11. both founders appear in `Ready to Review`, the unresolved/failure sheets
    contain neither company, and the run summary reports two selected
    companies plus the manual-LinkedIn statement;
12. no URL ending in `linkedin.com` reaches the fetch adapter and all injected
    LinkedIn publish client methods remain at zero calls.

The same E2E and runtime composition test prove unauthenticated
`AUTH_REQUIRED`, cross-owner `NOT_FOUND`, a non-leaking foreign-owner capability
download failure, and no owner data in the error result.

## Expanded regression evidence

The unaffected founder/MCP/HTTP regression command was:

```text
npx vitest run tests/founder-research/download-capability.test.ts tests/founder-research/export-service.test.ts tests/founder-research/founder-role.test.ts tests/founder-research/profile-url.test.ts tests/founder-research/run-service.test.ts tests/founder-research/workbook.test.ts tests/founder-export-card tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/mcp/http-safety.test.ts tests/http/founder-export-download.test.ts tests/http/founder-export-card-client.test.ts tests/http/mcp-lifecycle.test.ts tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts
```

Result:

```text
Test Files  17 passed (17)
Tests       266 passed (266)
```

The broader relevant command, including every founder-research service test,
was also run:

```text
npx vitest run tests/founder-research tests/founder-export-card tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/mcp/http-safety.test.ts tests/http/founder-export-download.test.ts tests/http/founder-export-card-client.test.ts tests/http/mcp-lifecycle.test.ts tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts
```

Result:

```text
Test Files  17 passed | 2 failed (19)
Tests       336 passed | 10 failed (346)
```

All ten failures are the pre-existing fixed-clock baseline limitation already
documented in the Task 11 and Task 12 reports: nine
`candidate-service.test.ts` cases and one `outreach-service.test.ts` case use
fixed July 25 operation timestamps after PGlite has created rows on July 26.
The database correctly rejects the resulting `updated_at < created_at` values
through the `founder_research_run_items_timestamps_check` and
`founder_research_run_people_timestamps_check` constraints. Task 13 did not
change either service, either test fixture, the repository clock, or the
constraints.

## Build and security verification

```text
npm run typecheck
```

Passed (`tsc --noEmit`).

```text
npm run build
```

Passed server compilation and the consent, review-card, and founder-export-card
bundles.

```text
npm audit --omit=dev
```

Passed: `found 0 vulnerabilities`.

```text
git diff --check
```

Passed with no whitespace errors.

```text
git show --check --oneline --stat HEAD
git show --check --oneline --stat 77dafae
git show --check --oneline --stat 85d6419
```

Passed. The required report-only Task 12 commit `77dafae` remains directly atop
the production base `85d6419`.

## Composition and security decisions

- Request identity is never accepted from founder-tool input. The four
  write-capable founder services close over `context.subject`.
- Unauthenticated factories receive no founder service dependency, so the MCP
  authentication boundary returns `AUTH_REQUIRED` before any repository call.
- The app-scoped downloader closes over the deployment's already required
  `ALLOWED_SUBJECT`; capabilities belonging to another owner return the same
  safe 404 as malformed or unavailable capabilities.
- Canonical card origin acceptance requires exact HTTPS origin spelling with no
  credentials, path, query, or fragment. Non-HTTPS development origins do not
  register the private card.
- Official discovery uses only the injected official-site fetch adapter.
  Candidate save receives a LinkedIn URL as non-fetching data and does not
  receive any HTTP dependency.
- The E2E fixtures are a three-request official-site allowlist: two homepages
  and one same-origin team page. Any unplanned URL, including LinkedIn, fails
  immediately.
- No send, connect, live network, migration, pilot, connector, deployment,
  branch push, or LinkedIn action was performed.

## Self-review against Task 13

- Owner-scoped run, candidate, outreach, and export services are request
  scoped: satisfied.
- Capability downloader is constructed once and injected at app scope:
  satisfied.
- Export resource uses the canonical HTTPS application origin: satisfied.
- Stateless MCP lifecycle and OAuth middleware ordering: preserved and covered
  by the 266-test regression.
- Two-company verified/unresolved workflow and public-search handoff:
  satisfied.
- Candidate non-fetch proof and manual confirmation: satisfied.
- Two immutable/versioned notes: satisfied and repository history checked.
- Export, card read, exact download, checksum, workbook reopen, four sheets,
  and summaries: satisfied.
- Unauthenticated and cross-owner non-leaking behavior: satisfied.
- Zero LinkedIn requests and zero send/connect operations: satisfied.
- Minimal official-site fixtures only: satisfied.
- Production security validation unchanged: satisfied.
- No live call or deployment: satisfied.

## Commit and progress-file preservation

The implementation and this report are intended for one commit with the exact
message:

```text
feat: compose founder research workflow
```

Because the report is included in that content-addressed commit, it cannot
safely contain its own final SHA; the final handoff supplies the resulting
commit hash.

The pre-existing `.superpowers/sdd/progress.md` modification was never edited,
staged, or committed. Its observed SHA-256 at final review is
`a5c404f4af2b73626a47268854ac352668de3b0a309cc8552637a85f5216132a`.

## Concerns

The only concern is the documented fixed-clock baseline limitation affecting
ten candidate/outreach tests when the real database clock has advanced past
their July 25 fixtures. The new Task 13 composition/E2E, relevant unaffected
founder/MCP/HTTP regressions, typecheck, build, production audit, and Git checks
all pass. No Task 13 production defect was observed.

## Precise Task 14 handoff

Task 14 should change documentation only, unless a documentation contract test
requires an intentional test update. It must:

1. document a safe daily ChatGPT prompt and repeated processing calls of at
   most five companies until public search or a terminal/export state;
2. explain that public-search candidates are not verified and require manual
   `CONFIRM` or `REJECT`;
3. explain evidence-backed notes, private export-card opening, and workbook
   regeneration;
4. state the 30-day evidence freshness, seven-day workbook retention, and
   15-minute capability lifetime;
5. require manual profile inspection and manual LinkedIn **Connect**, with an
   explicit prohibition on LinkedIn fetching, scraping, browser automation,
   sending, and messaging;
6. document migration order, deployment only from
   `codex/founder-research-export`, connector refresh, export-card verification,
   safe cleanup, and rollback without any secret value or sample credential;
7. search the README and runbook for misleading claims of complete founder
   coverage, verified candidate URLs, or automated LinkedIn outreach;
8. preserve `.superpowers/sdd/progress.md` and record the known fixed-clock
   baseline separately from Task 14 documentation results;
9. perform no live pilot, migration, deployment, or LinkedIn action—those
   remain Task 15 activities.

## Review-fix wave — card boundary, network proof, summaries, and teardown

### Findings addressed

The Task 13 E2E was strengthened without changing production code:

- The actual `export_founder_research_workbook` `CallToolResult` now enters the
  production `createFounderExportCardController` module used by the shipped
  card bundle through the exact ChatGPT host envelope:
  `toolOutput=structuredContent` and
  `toolResponseMetadata={status,call_tool_result,mcp_tool_result}`.
- The test asserts that the actual private result `_meta` contains exactly
  `downloadUrl` and `expiresAt`, both visible envelope copies reference the
  exact actual `structuredContent`, the controller renders only the safe
  summary, and the download becomes available.
- The controller is invoked through `download()`. The test captures exactly
  `openExternal({href,redirectUrl:false})` and gives only that captured URL to
  the HTTP capability route. It no longer downloads directly from the raw MCP
  result.
- The static MCP resource read remains in the scenario and confirms the exact
  canonical application origin while excluding the capability.
- A global network tripwire disables all non-loopback Node HTTP traffic with
  Nock and replaces global `fetch` with a failing spy. The official-site
  adapter remains a three-URL allowlist. The test asserts zero global fetches,
  no pending network mocks, no LinkedIn or `licdn.com` URL reaching the
  official fetch adapter, and zero publishing-client initialize/upload/post
  calls.
- The complete registered tool list is checked: it contains no invitation,
  message, or Connect action name; the sole tool described as a LinkedIn
  external write is `publish_exact_linkedin_post`, and it remains app-only.
  The scenario records all three clients' tool calls and proves that this
  external-write tool was never invoked. The founder outreach tool remains a
  private, non-open-world draft save whose description explicitly prohibits
  sending.
- `Run Summary` now has exact numeric cell assertions:
  `B9=2` processed, `B10=1` confirmed, `B11=1` verified, and
  `B12=B13=B14=B15=0` for candidate, ambiguous, not found, and failed.
- Teardown is phased and deterministic. MCP connections close in LIFO order
  before the database. Each cleanup failure is retained and reported through
  an `AggregateError`; later cleanups still run. Nock and Vitest mocks/globals
  are restored in `finally`, even when cleanup fails.
- The E2E clock is captured once at module load five minutes ahead of the real
  test database clock. The application clock, controller clock, official
  fixtures, and candidate `checkedAt` all receive that same captured instant.
  This avoids the already documented fixed-clock drift without weakening any
  timestamp validation.

### Review-fix RED

The first review-fix run revealed that the prior fixed
`2026-07-26T06:00:00.000Z` test instant had itself fallen behind new PGlite
rows. The failure was the documented test-clock problem, not the intended card
boundary regression. Only the E2E fixture clock was changed to the single
runtime-captured instant described above.

The intended RED was then run:

```text
npx vitest run tests/e2e/founder-research-flow.test.ts
```

Result:

```text
Test Files  1 failed (1)
Tests       1 failed (1)
```

The exact failure was that `capturedOpenExternalRequests` was `[]` instead of
the required single `{href, redirectUrl:false}` request. This proved that the
old E2E read the resource shell but never passed the actual export result
through the card controller.

### Review-fix GREEN and verification

Focused card/composition/E2E command:

```text
npx vitest run tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts tests/founder-export-card
```

Result:

```text
Test Files  5 passed (5)
Tests       35 passed (35)
```

Expanded unaffected founder/MCP/HTTP command:

```text
npx vitest run tests/founder-research/download-capability.test.ts tests/founder-research/export-service.test.ts tests/founder-research/founder-role.test.ts tests/founder-research/profile-url.test.ts tests/founder-research/run-service.test.ts tests/founder-research/workbook.test.ts tests/founder-export-card tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/mcp/http-safety.test.ts tests/http/founder-export-download.test.ts tests/http/founder-export-card-client.test.ts tests/http/mcp-lifecycle.test.ts tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts
```

Result:

```text
Test Files  17 passed (17)
Tests       266 passed (266)
```

`npm run typecheck`, `npm run build`, `npm audit --omit=dev`, `git diff
--check`, and `git show --check --oneline --stat HEAD` all passed. The
production audit again reported `found 0 vulnerabilities`.

After the final literal `send_*` registry guard was added, a fresh
`npx vitest run tests/e2e/founder-research-flow.test.ts` passed: 1 file and
1 test.

### Review-fix files and commit

- Modified `tests/e2e/founder-research-flow.test.ts`
- Modified `tests/e2e/fixtures.ts`
- Modified `.superpowers/sdd/task-13-report.md`

No production file changed in this review-fix wave. The review fix will be
committed separately from `ee949cb`; its final content-addressed SHA is supplied
in the handoff rather than self-referenced here.

The pre-existing `.superpowers/sdd/progress.md` remains untouched and unstaged.
No live call, LinkedIn action, migration, push, pilot, connector action, or
deployment was performed.
