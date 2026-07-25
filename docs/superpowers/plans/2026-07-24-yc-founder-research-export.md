# YC Founder Research and Outreach Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:test-driven-development` for every production change and
> `superpowers:verification-before-completion` before any completion claim.
> Execute the tasks in order because the database and service contracts are
> dependencies for the later MCP and UI tasks.

**Goal:** Add a production-ready, resumable workflow that researches up to 50
YC companies, saves evidence-backed founder identities and LinkedIn profile
candidates, prepares private 200-character connection-note drafts, and exports
a short-lived private Excel workbook for manual LinkedIn outreach.

**Architecture:** The existing YC provider and official-company people
discovery remain the only server-side web fetchers. A new owner-scoped run
coordinator leases at most five companies per tool call and processes at most
two concurrently. Unresolved people are returned as public-search tasks for
ChatGPT; candidate LinkedIn URLs are stored without fetching them and require
manual confirmation unless an official company person card explicitly linked
the URL. Existing targets and outreach drafts store versioned notes. A minimal
OOXML writer uses JSZip to create a deterministic four-sheet workbook whose
exact bytes live in private Postgres for seven days. A separate 15-minute,
single-purpose capability opens the download route through an MCP export card.

**Tech stack:** Node.js 22, TypeScript, Zod, Drizzle ORM/PostgreSQL, Supabase
Postgres/Auth, MCP SDK 1.29, JSZip 3.10.1, Express, Vitest/PGlite, Docker,
Railway.

## Global constraints

- Work only on `codex/founder-research-export`, based on
  `origin/codex/supabase-migration`. Do not merge or deploy `main`.
- Use Supabase project `jcurllwupihgkmcrydms`; never expose its database
  password, service-role key, user JWTs, LinkedIn tokens, or raw capability
  tokens.
- Do not add a Supabase service-role key or a public Storage bucket. Workbook
  bytes stay in private `career_mcp` Postgres tables.
- Never fetch a LinkedIn URL, scrape LinkedIn, click **Connect**, send a
  connection request, or automate a LinkedIn browser session.
- Treat official-company-card LinkedIn links as `VERIFIED`; public-search
  results are `CANDIDATE` until the user records `CONFIRMED` or `REJECTED`.
- Canonical URL precedence is `CONFIRMED`, then `VERIFIED`, then no canonical
  URL. A `CANDIDATE` never replaces either higher-confidence state.
- Keep structured research history indefinitely. Treat evidence older than
  30 days as stale and attempt a refresh while preserving the historical row.
- Limit a run to 50 companies, one processing call to 5 companies, and
  processing concurrency to 2 companies.
- Limit connection notes to 200 Unicode code points. Every personalized claim
  must cite stored evidence.
- Produce exactly four sheets: `Ready to Review`, `Needs Verification`,
  `Not Found - Failed`, and `Run Summary`.
- Neutralize spreadsheet formula injection and emit no formulas, macros,
  external workbook links, hidden content, or remote images.
- Workbook artifacts expire after seven days; download capabilities expire
  after 15 minutes and are never returned in model-visible text or
  `structuredContent`.
- Every owner-scoped lookup returns `NOT_FOUND` for another owner.
- Scheduled/model-driven flows may research, save candidates, save outreach
  drafts, and create a private export. They may not interact with LinkedIn.
- Follow red-green-refactor. Each task ends with focused tests and a small
  commit.

## File structure

### New production files

- `src/founder-research/types.ts`
- `src/founder-research/profile-url.ts`
- `src/founder-research/founder-role.ts`
- `src/founder-research/candidate-service.ts`
- `src/founder-research/run-service.ts`
- `src/founder-research/outreach-service.ts`
- `src/founder-research/workbook.ts`
- `src/founder-research/export-service.ts`
- `src/founder-research/download-capability.ts`
- `src/founder-export-card/resource.ts`
- `src/founder-export-card/controller.ts`
- `src/founder-export-card/client.ts`
- `scripts/build-founder-export-card.mjs`

### New tests

- `tests/founder-research/profile-url.test.ts`
- `tests/founder-research/founder-role.test.ts`
- `tests/founder-research/candidate-service.test.ts`
- `tests/founder-research/run-service.test.ts`
- `tests/founder-research/outreach-service.test.ts`
- `tests/founder-research/workbook.test.ts`
- `tests/founder-research/export-service.test.ts`
- `tests/founder-research/download-capability.test.ts`
- `tests/founder-export-card/resource.test.ts`
- `tests/founder-export-card/controller.test.ts`
- `tests/http/founder-export-download.test.ts`
- `tests/e2e/founder-research-flow.test.ts`

### Existing files modified

- `package.json` and `package-lock.json`
- `src/db/schema.ts`
- `src/db/repositories.ts`
- `src/db/client.ts` only if the inferred repository return type needs a named
  export; do not weaken database URL or TLS validation
- `src/domain/errors.ts`
- `src/mcp/schemas.ts`
- `src/mcp/server.ts`
- `src/http/app.ts`
- `src/index.ts`
- `src/config.ts` only for bounded retention/capability defaults if they are
  intentionally configurable
- `tests/support/database.ts`
- `tests/db/repositories.test.ts`
- `tests/db/schema-hardening.test.ts`
- `tests/db/runtime-role.test.ts`
- `tests/mcp/tools.test.ts`
- `tests/mcp/annotations.test.ts`
- `tests/mcp/http-safety.test.ts`
- `tests/runtime/async-composition.test.ts`
- `tests/build/dockerfile.test.ts`
- `scripts/build-review-card.mjs` only if shared build helpers are extracted
- `Dockerfile`
- `README.md`
- `docs/deployment/supabase-railway-chatgpt.md`
- `supabase/runtime-role.sql`
- generated Drizzle migration, journal, and snapshot files

---

### Task 1: Add JSZip as a pinned production dependency

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/build/production-dependencies.test.ts`

- [ ] **Step 1: Write the failing production-dependency test**

Assert that `jszip` is present in `dependencies`, absent from
`devDependencies`, and pinned to an exact version rather than a range.

- [ ] **Step 2: Run the focused test**

Run:

```bash
npx vitest run tests/build/production-dependencies.test.ts
```

Expected: FAIL because JSZip is not installed.

- [ ] **Step 3: Install the audited JSZip release**

The current stable registry version checked on 2026-07-24 is `3.10.1`. Review
its direct and transitive production dependencies, then install it exactly:

```bash
npm install --save-exact jszip@3.10.1
npm audit --omit=dev
```

Do not use a floating range and do not accept a production audit exception.
ExcelJS 4.4.0 was explicitly rejected during pre-flight because its current
production dependency graph reported high-severity vulnerabilities through
`archiver`, `glob`, `minimatch`, and related packages.

- [ ] **Step 4: Re-run the focused test and typecheck**

```bash
npx vitest run tests/build/production-dependencies.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/build/production-dependencies.test.ts
git commit -m "build: add Excel workbook dependency"
```

---

### Task 2: Add the owner-scoped research and export schema

**Files:**

- Modify: `tests/db/repositories.test.ts`
- Modify: `tests/db/schema-hardening.test.ts`
- Modify: `tests/db/runtime-role.test.ts`
- Modify: `tests/support/database.ts`
- Modify: `src/db/schema.ts`
- Modify: `supabase/runtime-role.sql`
- Create: next generated `drizzle/0007_*.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: next generated `drizzle/meta/0007_snapshot.json`

**Tables:**

- `founder_research_runs`
- `founder_research_run_items`
- `founder_research_run_people`
- `founder_profile_candidates`
- `founder_profile_confirmation_events`
- `founder_research_exports`
- `founder_export_download_capabilities`

- [ ] **Step 1: Write failing schema-inventory and constraint tests**

Test all table names, foreign keys, unique keys, owner indexes, state checks,
count/range checks, SHA-256 formats, MIME restrictions, and timestamp
relationships. Required highlights:

```text
requested_limit: 1..50
attempt_count: >= 0
export byte_size: 1..5 MiB
export mime_type:
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
candidate state: CANDIDATE | VERIFIED | CONFIRMED | REJECTED
run state: PENDING | RUNNING | NEEDS_PUBLIC_SEARCH | COMPLETE | PARTIAL | FAILED
item state:
  PENDING | LEASED | NEEDS_PUBLIC_SEARCH | COMPLETE | PARTIAL |
  NOT_FOUND | AMBIGUOUS | FAILED
```

Add the new tables to `resetForTests()` in child-to-parent order.

- [ ] **Step 2: Run database tests and confirm failure**

```bash
npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts
```

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Define tables in `src/db/schema.ts`**

Use explicit checks and indexes. Store `query_json`, evidence metadata, and
safe error detail as typed `jsonb`. Store workbook bytes in a Drizzle `bytea`
custom type that maps only `Buffer`/`Uint8Array`; never serialize workbook
bytes into JSON or base64.

Every table that contains private run/export state includes
`owner_subject`. Child tables either include and constrain the owner directly
or are reachable only through a composite owner foreign key. Prefer composite
keys where they make cross-owner insertions impossible at the database layer.

- [ ] **Step 4: Generate and inspect the migration**

```bash
npx drizzle-kit generate --name yc_founder_research_export
```

Verify the generated file is `0007_*`, updates the journal/snapshot, creates
only private `career_mcp` objects, and contains no `public`, `storage`,
`service_role`, RLS disabling, credential, or destructive statement.

- [ ] **Step 5: Harden runtime-role privileges**

Update `supabase/runtime-role.sql` so idempotent provisioning grants the
runtime role only the needed CRUD access. Explicitly keep raw download
capability hashes and workbook bytes unavailable to public Supabase roles.
Test the script text for the expected grants and absence of unsafe roles.

- [ ] **Step 6: Run focused database tests**

```bash
npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle supabase/runtime-role.sql tests/db tests/support/database.ts
git commit -m "feat: add founder research export schema"
```

---

### Task 3: Add transactional repositories and state precedence

**Files:**

- Modify: `src/db/repositories.ts`
- Modify: `tests/db/repositories.test.ts`
- Modify: `src/domain/errors.ts` if new safe codes are required

**Repository contracts:**

- `founderResearchRuns.create/getOwned/recomputeCounters`
- `founderResearchRuns.leaseNextItems/releaseExpiredLeases`
- `founderResearchRuns.completeItem/failItem`
- `founderResearchPeople.saveOfficial/listForRun`
- `founderProfileCandidates.saveCandidate/recordOfficial/confirm/reject`
- `founderProfileCandidates.getCanonicalForPerson`
- `founderResearchExports.create/getOwned/deleteExpired`
- `founderExportCapabilities.create/recordDownload/getUsable`

- [ ] **Step 1: Write failing repository tests**

Cover:

- immutable run membership;
- owner isolation returning no row;
- deterministic lease order and maximum five items;
- expired-lease recovery;
- two callers never leasing the same item;
- partial failure isolation;
- derived run counters;
- duplicate candidate idempotency;
- `CONFIRMED > VERIFIED > CANDIDATE` precedence;
- rejection retaining an audit event;
- workbook/checksum round-trip;
- capability hash storage without raw token;
- repeatable download within the 15-minute lifetime and
  `last_downloaded_at` updates;
- serializable retry behavior using the existing transaction helper.

- [ ] **Step 2: Run focused repository tests**

```bash
npx vitest run tests/db/repositories.test.ts
```

Expected: FAIL because the repository methods do not exist.

- [ ] **Step 3: Implement normalized row types and repositories**

Follow the existing timestamp normalization, UUID validation, constraint
mapping, and serializable transaction conventions. Never accept an
`ownerSubject` from model arguments; services supply the authenticated subject.
Store only SHA-256 capability hashes. Use constant-time comparison where an
in-memory comparison is required.

- [ ] **Step 4: Re-run focused tests**

```bash
npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts src/domain/errors.ts tests/db/repositories.test.ts
git commit -m "feat: persist founder research state"
```

---

### Task 4: Validate founder roles, identities, and non-fetching profile URLs

**Files:**

- Create: `src/founder-research/types.ts`
- Create: `src/founder-research/founder-role.ts`
- Create: `src/founder-research/profile-url.ts`
- Create: `tests/founder-research/founder-role.test.ts`
- Create: `tests/founder-research/profile-url.test.ts`

- [ ] **Step 1: Write failing pure-domain tests**

Founder-like roles include normalized forms of founder, co-founder,
cofounder, founding CEO, and founder/CEO. They exclude founding engineer,
founding designer, investor, advisor, and unrelated executive roles unless the
text separately asserts founder. A plain `CEO` is accepted only when separate
official YC or saved public evidence explicitly identifies that same person as
a founder.

Profile URL tests require:

- HTTPS;
- hostname exactly `linkedin.com` or a subdomain ending `.linkedin.com`;
- path shaped like `/in/<slug>` with no credentials;
- fragment removal;
- tracking-query removal;
- rejection of company, jobs, feed, search, posts, shortened, malformed, and
  non-LinkedIn URLs;
- a branded `NonFetchingLinkedInProfileUrl` return type.

- [ ] **Step 2: Run tests and confirm failure**

```bash
npx vitest run tests/founder-research/founder-role.test.ts tests/founder-research/profile-url.test.ts
```

- [ ] **Step 3: Implement the pure validators**

Normalize Unicode to NFC, collapse whitespace, apply explicit character/byte
limits, and return safe structured validation reasons. The URL module may
parse and normalize URLs but must contain no network operation.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research tests/founder-research
git commit -m "feat: validate founder identities and profile URLs"
```

---

### Task 5: Implement candidate submission and manual confirmation

**Files:**

- Create: `src/founder-research/candidate-service.ts`
- Create: `tests/founder-research/candidate-service.test.ts`

**Public-search candidate input:**

- run item/person reference;
- founder name and role;
- candidate profile URL;
- exact search query;
- result URL;
- bounded result title and snippet;
- checked time;
- confidence;
- explicit statement that LinkedIn was not fetched.

- [ ] **Step 1: Write failing service tests**

Cover valid candidate save, duplicate idempotency, malformed/stale evidence,
LinkedIn-result URL mismatch, overlong fields, wrong owner, ambiguous multiple
candidates, candidate not becoming canonical, official `VERIFIED` preservation,
manual `CONFIRMED`, manual `REJECTED`, repeated confirmation idempotency, and
conflicting decisions.

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run tests/founder-research/candidate-service.test.ts
```

- [ ] **Step 3: Implement the owner-scoped service**

The service validates but never fetches candidate URLs. It records exact
evidence and delegates precedence to one repository transaction. Confirmation
events include actor owner, decision, optional bounded note, and timestamp.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research/candidate-service.ts tests/founder-research/candidate-service.test.ts
git commit -m "feat: review founder profile candidates"
```

---

### Task 6: Implement resumable YC founder research runs

**Files:**

- Create: `src/founder-research/run-service.ts`
- Create: `tests/founder-research/run-service.test.ts`
- Modify: `src/research/people-discovery.ts` only if a narrow reusable
  official-evidence projection is required
- Modify: `src/research/types.ts` only for that projection

**Service methods:**

- `startRun(query, limit)`
- `processRun(runId, maxCompanies)`
- `getRun(runId)`

- [ ] **Step 1: Write failing coordinator tests**

Use injected YC provider, official people discovery, clock, and concurrency
probe. Cover:

- 1..50 selection and immutable membership;
- deterministic YC company ordering/deduplication;
- at most five leased per call;
- at most two discoveries active concurrently;
- founder-role filtering;
- explicit official-card LinkedIn links saved as `VERIFIED`;
- official founder without URL producing one public-search task;
- no recognized founder producing a company/founder search task;
- no LinkedIn fetch;
- stale evidence refresh;
- partial company failure not failing the whole batch;
- resumability after lease expiry;
- final run states and counters;
- repeated processing idempotency.

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run tests/founder-research/run-service.test.ts
```

- [ ] **Step 3: Implement the coordinator**

Use the existing persisted YC provider and `PeopleDiscoveryService`. Execute a
small internal worker pool of size two, settle each item independently, and
always close or expire its lease through a repository transition. Return only
bounded safe public-search tasks:

```ts
type FounderPublicSearchTask = {
  runItemId: string;
  companyId: string;
  companyName: string;
  officialWebsiteUrl?: string;
  knownPersonId?: string;
  knownFounderName?: string;
  knownFounderRole?: string;
  suggestedQueries: string[];
  reason: "PROFILE_URL_MISSING" | "FOUNDER_NOT_FOUND" | "AMBIGUOUS";
};
```

Suggested queries must not instruct ChatGPT to open LinkedIn. They may search
the public web for indexed results.

- [ ] **Step 4: Re-run focused and existing research tests**

```bash
npx vitest run tests/founder-research/run-service.test.ts tests/research
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research/run-service.ts src/research tests/founder-research/run-service.test.ts
git commit -m "feat: run resumable YC founder research"
```

---

### Task 7: Save evidence-backed 200-character outreach batches

**Files:**

- Create: `src/founder-research/outreach-service.ts`
- Create: `tests/founder-research/outreach-service.test.ts`

- [ ] **Step 1: Write failing outreach tests**

Cover:

- only `CONFIRMED` or `VERIFIED` people are ready by default;
- candidate-only rows remain in needs-verification;
- NFC normalization and 200 Unicode code-point maximum;
- exact evidence IDs must belong to the selected person;
- every personalization claim must be supported by evidence;
- generic safe note allowed with an empty personalization claim list;
- one version per target/purpose;
- duplicate batch request idempotency;
- wrong owner and missing run/person;
- no send/connect side effect.

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run tests/founder-research/outreach-service.test.ts
```

- [ ] **Step 3: Implement by reusing pipeline and draft repositories**

Create or reuse a target with status `discovered`; save the note as an
`outreach_drafts` version with purpose `linkedin_connection_request`. Store
the evidence IDs already supported by the table. Return draft IDs and
versions, never a LinkedIn action.

- [ ] **Step 4: Re-run tests**

```bash
npx vitest run tests/founder-research/outreach-service.test.ts tests/drafts/service.test.ts tests/pipeline/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research/outreach-service.ts tests/founder-research/outreach-service.test.ts
git commit -m "feat: save founder connection note batches"
```

---

### Task 8: Build and verify the four-sheet Excel workbook

**Files:**

- Create: `src/founder-research/workbook.ts`
- Create: `tests/founder-research/workbook.test.ts`

- [ ] **Step 1: Write failing workbook contract tests**

Build a representative run containing confirmed, verified, candidate,
ambiguous, not-found, and failed rows. Assert:

- exact four-sheet names and order;
- stable column names/order;
- frozen header row, auto-filter, readable widths, date and confidence formats;
- correct state-to-sheet routing;
- canonical URL only for confirmed/verified rows;
- candidate URL visible only in needs-verification;
- note text and evidence columns;
- summary counters matching source data;
- strings beginning with `=`, `+`, `-`, or `@` are neutralized;
- no formula cells, hyperlinks, hidden rows/columns/sheets, defined names,
  macros, drawings, external links, or remote images;
- deterministic content ordering;
- successful in-memory ZIP generation as a Node `Buffer`;
- reopening the exact bytes with JSZip and CRC32 validation preserves the
  expected OOXML entries and content;
- byte size stays below 5 MiB at the 50-company maximum.

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run tests/founder-research/workbook.test.ts
```

- [ ] **Step 3: Implement the workbook builder**

Generate the minimum standards-compliant OOXML package: content types, root
relationships, workbook, workbook relationships, one styles part, document
properties, and four worksheet parts using inline strings. Treat all dynamic
values as plain text/numbers/dates. Prefix dangerous spreadsheet text with a
single quote before XML escaping. Do not emit formula, hyperlink, drawing,
external-link, macro, shared-string, or hidden-content elements. Give every ZIP
entry the same fixed timestamp and deterministic order, then generate a Node
buffer with DEFLATE compression. Reopen with JSZip using `checkCRC32: true` and
validate exact entry names before accepting the bytes.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research/workbook.ts tests/founder-research/workbook.test.ts
git commit -m "feat: generate safe founder research workbooks"
```

---

### Task 9: Persist exports and issue private download capabilities

**Files:**

- Create: `src/founder-research/export-service.ts`
- Create: `src/founder-research/download-capability.ts`
- Create: `tests/founder-research/export-service.test.ts`
- Create: `tests/founder-research/download-capability.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

- owner-scoped export from a saved run;
- exact bytes, checksum, MIME, filename, row counts, and seven-day expiry;
- same idempotency key returns the same unexpired export;
- a changed run snapshot creates a new export;
- random 256-bit capability token;
- only token hash stored;
- 15-minute expiry with repeatable use during that lifetime;
- wrong export/owner, expired token, and checksum mismatch;
- raw token excluded from logs, errors, structured result, and repository rows;
- expired artifact cleanup.

- [ ] **Step 2: Run focused tests**

```bash
npx vitest run tests/founder-research/export-service.test.ts tests/founder-research/download-capability.test.ts
```

- [ ] **Step 3: Implement services**

Hash capability tokens with SHA-256, keep raw tokens in memory only long enough
to build the private card metadata, and use `timingSafeEqual` for comparable
buffers. An export record owns exact workbook bytes; a capability authorizes
downloads of only that export during its 15-minute lifetime and no other
action. Browser preflight or an interrupted download must not consume it.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/founder-research/export-service.ts src/founder-research/download-capability.ts tests/founder-research
git commit -m "feat: secure founder workbook exports"
```

---

### Task 10: Add the capability-protected download route

**Files:**

- Modify: `src/http/app.ts`
- Create: `tests/http/founder-export-download.test.ts`
- Modify: `tests/mcp/http-safety.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Test:

- `GET /research-exports/:exportId/download?capability=<token>`;
- valid response status, XLSX MIME, attachment filename, length, checksum
  ETag, `Cache-Control: no-store`, `Pragma: no-cache`,
  `X-Content-Type-Options: nosniff`, and restrictive CSP;
- missing/malformed/expired/wrong capability returns the same safe 404/410
  surface without revealing which component failed;
- no raw token in response body or logs;
- no body parser or MCP authentication regression;
- HEAD and unsupported methods do not expose bytes;
- response bytes exactly match the persisted export.

- [ ] **Step 2: Run focused HTTP tests**

```bash
npx vitest run tests/http/founder-export-download.test.ts tests/mcp/http-safety.test.ts
```

- [ ] **Step 3: Add a narrow HTTP dependency**

Inject a `downloadFounderExport(exportId, capability)` function into
`createHttpApp`. Register the route before the generic MCP handler. Stream or
send the exact stored buffer only after repository/service verification.
Never log the query string.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/app.ts tests/http/founder-export-download.test.ts tests/mcp/http-safety.test.ts
git commit -m "feat: serve private founder workbooks"
```

---

### Task 11: Add the private ChatGPT export card

**Files:**

- Create: `src/founder-export-card/resource.ts`
- Create: `src/founder-export-card/controller.ts`
- Create: `src/founder-export-card/client.ts`
- Create: `scripts/build-founder-export-card.mjs`
- Create: `tests/founder-export-card/resource.test.ts`
- Create: `tests/founder-export-card/controller.test.ts`
- Modify: `src/http/app.ts`
- Modify: `package.json`
- Modify: `tests/build/dockerfile.test.ts`
- Modify: `Dockerfile` only if the existing `dist/public` copy is not generic

- [ ] **Step 1: Write failing resource/controller tests**

The card renders safe model-visible run summary and one **Download Excel**
button. The raw URL/capability is accepted only from
`window.openai.toolResponseMetadata`, never `toolOutput` or
`structuredContent`. Test unavailable/expired states, repeated globals
updates, URL origin/path validation, no HTML injection, and no tool that
mutates LinkedIn.

- [ ] **Step 2: Run focused tests**

```bash
npx vitest run tests/founder-export-card
```

- [ ] **Step 3: Implement and build the resource**

Use URI `ui://pmm-career-mcp/founder-export-card.html`. Restrict the widget
domain/CSP to the canonical Railway application origin. Serve the bundled
client from `/founder-export-card-client.js` with no-cache/nosniff headers.
The button opens only the validated same-origin download URL supplied in
private metadata.

- [ ] **Step 4: Update build scripts and Docker checks**

Add `build:founder-export-card` to `npm run build`. Confirm the runtime image
contains the bundled client.

- [ ] **Step 5: Re-run tests and build**

```bash
npx vitest run tests/founder-export-card tests/build/dockerfile.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/founder-export-card scripts/build-founder-export-card.mjs src/http/app.ts package.json Dockerfile tests
git commit -m "feat: add founder workbook export card"
```

---

### Task 12: Expose the six MCP tools with strict contracts

**Files:**

- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/annotations.test.ts`

**Tools:**

- `start_yc_founder_research`
- `process_yc_founder_research`
- `save_founder_profile_candidates`
- `confirm_founder_profile_candidate`
- `save_founder_outreach_batch`
- `export_founder_research_workbook`

- [ ] **Step 1: Write failing MCP schema/tool tests**

Test exact input/output schema bounds, strict unknown-key rejection, safe error
mapping, tool summaries, pagination/bounded arrays, annotations, and
owner-derived context. Required annotation intent:

- start/process/candidate/confirm/outreach/export are private-write tools;
- process is open-world because it fetches official public sources;
- candidate save is not open-world because it validates supplied evidence and
  performs no fetch;
- export uses the export-card output template;
- none are destructive or LinkedIn external-write tools.

Assert the raw capability/download URL is absent from text and
`structuredContent` and present only in result `_meta` used by the widget.

- [ ] **Step 2: Run focused MCP tests**

```bash
npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts
```

- [ ] **Step 3: Add strict Zod schemas**

Limit batches, strings, evidence arrays, and candidates. Return stable IDs and
safe summaries. `process_yc_founder_research` returns at most five item
outcomes and a bounded list of unresolved public-search tasks.

- [ ] **Step 4: Register tools and strengthen instructions**

Update `CAREER_MCP_INSTRUCTIONS` to explain:

- server-side research never fetches LinkedIn;
- ChatGPT may use public search for unresolved candidates;
- candidates require manual confirmation;
- exports support manual connection work only;
- no connection request or message is sent.

- [ ] **Step 5: Re-run focused tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp tests/mcp
git commit -m "feat: expose YC founder research tools"
```

---

### Task 13: Compose request-scoped services and complete the end-to-end flow

**Files:**

- Modify: `src/index.ts`
- Modify: `src/http/app.ts`
- Modify: `tests/runtime/async-composition.test.ts`
- Create: `tests/e2e/founder-research-flow.test.ts`
- Modify: `tests/e2e/fixtures.ts`
- Add only minimal official-site fixtures needed by the scenario

- [ ] **Step 1: Write failing composition and E2E tests**

The E2E flow must:

1. start a two-company run;
2. discover one official verified founder and one unresolved founder;
3. return a public-search task;
4. save a candidate without any LinkedIn fetch;
5. confirm the candidate;
6. save two versioned connection notes;
7. export the workbook;
8. open the card;
9. download and reopen the exact workbook;
10. verify all four sheets and summaries;
11. verify zero LinkedIn requests and zero send/connect operations.

Also test unauthenticated requests and cross-owner access.

- [ ] **Step 2: Run the failing tests**

```bash
npx vitest run tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts
```

- [ ] **Step 3: Compose services in `createCareerApplication`**

Construct owner-scoped run, candidate, outreach, and export services inside the
request-scoped MCP factory. Compose the capability download service once at
application scope and inject it into the HTTP app. Preserve the existing
stateless MCP lifecycle and OAuth middleware order.

- [ ] **Step 4: Re-run E2E and regression tests**

```bash
npx vitest run tests/runtime/async-composition.test.ts tests/e2e/founder-research-flow.test.ts tests/e2e/career-flow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/http/app.ts tests/runtime tests/e2e
git commit -m "feat: compose founder research workflow"
```

---

### Task 14: Document operation, retention, and manual outreach

**Files:**

- Modify: `README.md`
- Modify: `docs/deployment/supabase-railway-chatgpt.md`
- Modify: `tests/build/dockerfile.test.ts` if documentation commands are
  contract-tested

- [ ] **Step 1: Add user-facing workflow documentation**

Document:

- a safe daily ChatGPT prompt;
- processing multiple bounded calls until the run reaches a terminal or
  public-search state;
- how candidate confirmation works;
- how to draft notes and export the workbook;
- 30-day evidence freshness, seven-day artifacts, 15-minute downloads;
- manual LinkedIn profile review and manual **Connect**;
- explicit prohibition on browser automation and LinkedIn scraping.

- [ ] **Step 2: Add deployment/runbook details**

Document migration order, Railway branch
`codex/founder-research-export`, connector refresh, export-card check, safe
cleanup, and rollback. Do not include any secret value or sample credential.

- [ ] **Step 3: Review all docs for misleading claims**

Search for claims of complete founder coverage, verified candidate URLs, or
automated LinkedIn outreach and remove them.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/deployment/supabase-railway-chatgpt.md
git commit -m "docs: explain founder research workflow"
```

---

### Task 15: Full verification, Supabase migration, pilots, and rollout

**Files:**

- Modify only files needed to fix verified failures
- Record production-safe operational notes in
  `docs/deployment/supabase-railway-chatgpt.md`

- [ ] **Step 1: Refresh platform guidance**

Before touching the live Supabase project, read the current Supabase changelog
and current migration/Postgres guidance. Confirm no relevant breaking change
affects the CLI, Postgres version, database roles, or bytea behavior.

- [ ] **Step 2: Run the complete local verification suite**

```bash
npm run typecheck
npm run build
npm test
npm run test:coverage
npm audit --omit=dev
docker build -t pmm-career-mcp:founder-research .
docker run --rm pmm-career-mcp:founder-research node --version
git diff --check
git status --short
```

Expected: all tests/builds pass, production audit has zero unresolved
vulnerabilities, and only intended changes remain.

- [ ] **Step 3: Perform a clean-database migration test**

Create a fresh PGlite database from all Drizzle migrations, exercise every new
repository, export and reopen a maximum-size workbook, then close cleanly.

- [ ] **Step 4: Apply the migration to Supabase through the existing
production migration path**

Use the existing private migration credential. Pause for the user if a
password must be entered. Never print or store the credential. Verify the
seven tables, constraints, indexes, grants, and runtime-role CRUD behavior with
read-only metadata queries.

- [ ] **Step 5: Push the feature branch**

```bash
git push -u origin codex/founder-research-export
```

Do not deploy `main`.

- [ ] **Step 6: Deploy Railway from the feature branch**

Use the existing Railway project/service and existing production variables.
Do not initiate a paid plan or billable upgrade. Watch build, migration, health,
and readiness results. Confirm the running commit equals the pushed commit.

- [ ] **Step 7: Refresh the ChatGPT connector**

Refresh PMM Career MCP so the six new tools and export card are discovered.
Confirm the widget domain/CSP contains only the Railway and existing approved
origins.

- [ ] **Step 8: Run a read-only 10-company pilot**

Use hiring YC companies, inspect official-source evidence, unresolved tasks,
candidate states, workbook sheets, and URL precedence. Do not confirm a result
without user review. Do not access LinkedIn through the MCP.

- [ ] **Step 9: Run the bounded 50-company pilot**

Advance with repeated five-company calls. Verify:

- no more than two concurrent official-site discoveries;
- no duplicate memberships or leases;
- partial failures remain isolated;
- all 50 companies have a durable terminal or needs-search outcome;
- the workbook reopens and matches database counters;
- no LinkedIn network request, connection request, or message occurred.

- [ ] **Step 10: Final evidence-backed report**

Report the deployed commit, test counts, health/readiness, migration status,
pilot counts by state, workbook checksum/expiry without its capability token,
known coverage limits, and the exact manual steps the user must perform in
LinkedIn.
