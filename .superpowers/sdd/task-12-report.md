# Task 12 report — YC founder-research MCP tools

## Implementation summary

Registered exactly six authenticated, owner-scoped founder-research tools:

- `start_yc_founder_research`
- `process_yc_founder_research`
- `save_founder_profile_candidates`
- `confirm_founder_profile_candidate`
- `save_founder_outreach_batch`
- `export_founder_research_workbook`

Each tool has a strict Zod input/output contract, bounded model-visible
projection, stable DomainError-only error result, private non-destructive
annotations, and OAuth metadata. Processing is the only open-world tool. It
projects at most five item outcomes and 25 public-search tasks. Candidate and
outreach batches are capped at 25. Candidate saves either use an existing
run-person or safely establish an unresolved founder from the supplied bounded
evidence, without fetching LinkedIn.

The export tool registers the Task 11 card resource whenever the injected
founder-research services provide an application origin. It returns the exact
controller-safe `data.export` projection and only `{ downloadUrl, expiresAt }`
in result `_meta`; the capability and URL are absent from text and
`structuredContent`. Export idempotency is the stable
`founder-export:<runId>:v1` key.

`CAREER_MCP_INSTRUCTIONS` now explicitly says that founder research does not
fetch LinkedIn, unresolved candidates use public search and manual decisions,
and export supports manual LinkedIn work only—no connection request or message
is sent.

## Approved plan discrepancy

The written design mentions `excludeResearchedWithinDays`, but the pre-existing
Task 6 `FounderResearchRunService.startRun(query, limit)` interface cannot
accept or apply it. Per controller direction, this MCP contract deliberately
omits the field rather than silently accepting an ignored exclusion window.

## TDD evidence

### RED

Before production edits:

```text
npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts
```

Result: 2 files failed, 3 tests failed, 22 passed. The failures were exactly
the missing six tool registrations/annotations and undefined new founder input
schemas.

The approved export metadata extension was independently red first:

```text
npx vitest run tests/founder-research/export-service.test.ts
```

Result: 1 failed, 4 passed. `FounderResearchExportMetadata.runId` was undefined,
demonstrating that the card-safe envelope could not yet be assembled.

Additional RED cycles covered unresolved founder identity delegation, mandatory
result title/snippet, 200 Unicode-code-point notes, stable export idempotency,
card-resource registration, output-note Unicode handling, and shared
non-fetching LinkedIn URL normalization. The focused MCP RED reported the
missing optional `runPersonId` handling, timestamp-derived export key, UTF-16
output truncation, unsafe query acceptance, and case-insensitive URL matching
before those production corrections.

### GREEN and verification

```text
npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/founder-research/export-service.test.ts tests/founder-export-card tests/http/founder-export-card-client.test.ts
```

Passed: 6 files, 57 tests.

```text
npm run typecheck
npm run build
npm audit --omit=dev
git diff --check
```

All passed. Production audit reported `found 0 vulnerabilities`.

An expanded founder regression run also passed all MCP, export service, and
export-card tests. It retained ten pre-existing failures in candidate/outreach
fixtures: their fixed July 25 timestamps are earlier than rows created by the
real current clock, violating existing timestamp constraints. Task 12 did not
modify those services or fixtures.

## Files changed

- `src/mcp/schemas.ts`
- `src/mcp/server.ts`
- `src/founder-research/export-service.ts`
- `tests/mcp/tools.test.ts`
- `tests/mcp/annotations.test.ts`
- `tests/founder-research/export-service.test.ts`
- `.superpowers/sdd/task-12-report.md`

The pre-existing `.superpowers/sdd/progress.md` change was not modified, staged,
or committed.

## Self-review

- No owner identifier is accepted from any founder-tool input; services are
  injected owner-scoped and every tool rejects missing request authentication.
- Candidate URLs are validated as non-fetching LinkedIn `/in/` values, result
  URLs must correlate to the candidate URL, and candidate save performs no
  fetch.
- Process is the sole founder tool marked open-world; all six are private,
  reversible, non-destructive writes and none is a LinkedIn external write.
- Model-visible outputs omit owner subject, diagnostics, credentials, raw
  capability, download URL, and workbook bytes. Export `_meta` has exactly two
  keys and the Task 11 card receives the exact canonical safe envelope.
- All output arrays and summaries are bounded; process outcomes/public tasks
  are capped at five/25.

## Concerns

The deferred `excludeResearchedWithinDays` behavior remains unavailable until a
future owner-scoped run-service interface can truly implement it. The known
timestamp-fixture failures above prevent calling the complete founder-service
suite green, but are unrelated to Task 12 changes.

## Task 13 interface requirements

Task 13 must construct `CareerMcpDependencies.founderResearch` per authenticated
request with the authenticated subject and one canonical HTTPS `applicationUrl`.
It must inject owner-scoped `runs`, `candidates`, `outreach`, and `exports`
services, including `saveCandidateForRunItem`. Export metadata must continue to
include safe `id`, `runId`, `createdAt`, `expiresAt`, `rowCount`, `sheetCount`,
and `checksumSha256`; the capability consumer remains private. Do not add an
owner input field or compose a LinkedIn fetch/write dependency.

Commit SHA: supplied in the final handoff. This report is included in that
content-addressed commit and therefore cannot safely self-reference its own
final SHA.
