# YC Founder Research and Outreach Export Design

Date: 2026-07-24

Status: Approved product direction; written specification awaiting user review

Audience: One private user operating PMM Career MCP through ChatGPT

## 1. Objective

Extend PMM Career MCP so a daily ChatGPT run can research up to 50 YC
companies, identify founders from allowed public sources, preserve the evidence
and confidence of every result, prepare short personalized connection notes,
and produce a private Excel workbook for manual LinkedIn review.

The MCP becomes the durable research ledger. ChatGPT remains the reasoning and
public-web-search layer. LinkedIn remains a manual destination for connection
requests.

The feature must never:

- fetch, scrape, or crawl a LinkedIn page;
- click **Connect**;
- send a connection request or message;
- use a browser agent to automate LinkedIn;
- claim that a founder or profile URL is verified without the required
  evidence;
- overwrite a previously confirmed or officially verified profile URL with a
  lower-confidence search candidate.

## 2. User outcome

At the end of a successful daily run, the user receives a private workbook
with:

- YC company and batch;
- founder name and role;
- official company website;
- LinkedIn profile URL, if available;
- profile URL status and evidence;
- confidence and review status;
- a short personalization rationale;
- a draft LinkedIn connection note;
- an outreach status that the user can update later.

The database remains the canonical source. The workbook is a short-lived,
derived snapshot that can be regenerated.

## 3. Confirmed product decisions

### 3.1 Source model

Research uses a hybrid MCP and ChatGPT design:

1. The MCP retrieves official YC company data and the stored official company
   website.
2. The MCP visits only the official company homepage and a bounded set of
   same-origin pages whose paths or labels indicate team, people, leadership,
   about, or company information.
3. The MCP extracts people from recognizable person cards and records exact
   source evidence.
4. An explicit LinkedIn link embedded in that person's card on an official
   company page is recorded as `VERIFIED`.
5. When the official-source pass cannot identify a founder or profile URL, the
   MCP returns a bounded public-search task to ChatGPT.
6. ChatGPT may search the public web for unresolved people. It sends candidate
   identity and profile information, the exact search query, result URL,
   result title or snippet, and check time back to the MCP.
7. The MCP validates and stores those results as `CANDIDATE`; it does not open
   the LinkedIn URL.
8. The user may manually inspect a candidate and mark it `CONFIRMED` or
   `REJECTED`.

Search-result snippets are evidence that a URL is a plausible candidate. They
are not evidence that LinkedIn itself was fetched or that the profile belongs
to the person.

### 3.2 Profile URL states

Every LinkedIn profile result has exactly one of these user-visible states:

- `VERIFIED`: the exact profile URL was explicitly linked from an official YC
  or official company source for that person.
- `CANDIDATE`: public-web-search evidence suggests that the URL may belong to
  the person, but the user has not confirmed it.
- `CONFIRMED`: the user manually inspected and confirmed a candidate.
- `NOT_FOUND`: the allowed research paths produced no candidate.
- `AMBIGUOUS`: multiple plausible people or URLs remain and the system cannot
  choose safely.

`REJECTED` is retained internally as an audit state for a discarded candidate
but is presented in the unresolved workbook sheet rather than as a usable
profile.

The canonical usable URL selection order is:

1. current `CONFIRMED`;
2. current `VERIFIED`;
3. no canonical URL.

`CANDIDATE` URLs are never treated as canonical and never replace
`CONFIRMED` or `VERIFIED` values automatically.

### 3.3 Founder identity states

Founder identity and profile URL confidence are separate:

- An official company source can verify a founder identity even when it
  contains no LinkedIn URL.
- A public-search result can create a `CANDIDATE` founder identity when the
  official site is unrecognized or incomplete.
- A candidate founder identity must not silently become verified merely
  because a plausible LinkedIn URL was found.
- Manual confirmation promotes the selected person and URL together while
  retaining the original evidence and event history.

### 3.4 Persistence and retention

Structured companies, people, evidence, profile candidates, manual decisions,
targets, outreach drafts, research runs, and run outcomes are retained
indefinitely unless the user requests deletion.

Public evidence is considered fresh for 30 days. A later run may reuse fresh
evidence but records that reuse in the new run. Stale evidence remains
historical and triggers a refresh attempt.

Generated Excel artifacts expire after seven days. A download link expires
after 15 minutes. The user can create a fresh workbook from the database after
either expiry.

No raw LinkedIn HTML, LinkedIn search page, LinkedIn cookie, browser session,
access token, database credential, Supabase secret, or ChatGPT file URL is
stored in this feature.

## 4. Scope

### 4.1 Version-one scope

- One private owner authenticated through the existing Supabase OAuth flow.
- Up to 50 YC companies per research run.
- Existing YC filters: batch, industry, company status, location, keyword, and
  hiring status.
- Official company-page founder discovery.
- ChatGPT public-web fallback for unresolved founder identities and profile
  candidates.
- Resumable bounded processing.
- Durable evidence, candidate, confirmation, and outreach history.
- One versioned connection-note draft per selected founder.
- One `.xlsx` workbook per export.
- A private ChatGPT export card with a short-lived **Download Excel** control.
- Manual LinkedIn connection requests only.

### 4.2 Deferred scope

- Sending connection requests or messages through LinkedIn.
- Browser automation or extension-based LinkedIn interaction.
- LinkedIn Communications, Invitations, Sales Navigator, Recruiter, or partner
  APIs.
- Fetching LinkedIn profiles to enrich the workbook.
- Email enrichment, phone enrichment, or private contact databases.
- CSV as a separate export format.
- Importing workbook edits back into the database.
- Multi-user team workflows.
- Automatically scheduling the ChatGPT task from inside the MCP.

## 5. Architecture

### 5.1 Components

The feature adds five application components:

1. **Run coordinator**
   Selects YC companies, creates immutable run membership, leases bounded work,
   resumes interrupted work, and maintains summary counters.

2. **Founder research service**
   Reuses the existing YC and people-discovery services, filters founder-like
   roles, saves official evidence, and produces public-search tasks for
   unresolved items.

3. **Candidate and confirmation service**
   Validates public-search submissions, records candidates without fetching
   them, enforces state precedence, and records manual decisions.

4. **Outreach batch service**
   Reuses the existing targets and versioned outreach drafts. It rejects
   unsupported personalization and saves only evidence-backed notes.

5. **Workbook export service and card**
   Builds a workbook from one saved run, stores its bytes and checksum
   privately in Postgres for seven days, and renders a card whose private
   metadata contains a 15-minute download capability.

### 5.2 ChatGPT and MCP responsibilities

ChatGPT:

- starts and advances the run;
- uses the returned public-search tasks for unresolved people;
- searches the public web without opening LinkedIn pages;
- submits candidate records with exact evidence;
- drafts personalization from saved evidence;
- opens the export card;
- explains uncertainty to the user.

The MCP:

- owns state, budgets, validation, precedence, deduplication, and retention;
- fetches only allowed YC and official company sources;
- never fetches a LinkedIn URL;
- saves every source and decision;
- creates deterministic workbook snapshots;
- keeps download capabilities out of model-visible output.

## 6. Database design

All new application tables live in the private `career_mcp` schema. They are
owned by the migration owner. The runtime role receives only the explicit
table and sequence privileges required by the repositories. The public,
`anon`, `authenticated`, and `service_role` roles receive no direct table
privileges for these tables.

The existing `companies`, `people`, `evidence`, `targets`, and
`outreach_drafts` tables remain canonical and are reused.

### 6.1 `founder_research_runs`

- `id` UUID primary key
- `owner_subject` UUID, required and indexed
- `state`: `PENDING`, `RUNNING`, `NEEDS_PUBLIC_SEARCH`, `COMPLETE`,
  `PARTIAL`, or `FAILED`
- `query_json`: validated YC filters and selection rules
- `requested_limit`: integer from 1 through 50
- `selected_count`, `processed_count`, `complete_count`, `partial_count`,
  `ambiguous_count`, `not_found_count`, and `failed_count`
- `created_at`, `started_at`, `completed_at`, and `updated_at`

The selected company membership is immutable. Counters are derived and checked
against the run items in repository tests.

### 6.2 `founder_research_run_items`

- `id` UUID primary key
- `run_id` foreign key
- `company_id` foreign key
- `state`: `PENDING`, `LEASED`, `NEEDS_PUBLIC_SEARCH`, `COMPLETE`, `PARTIAL`,
  `NOT_FOUND`, `AMBIGUOUS`, or `FAILED`
- `attempt_count`
- `lease_expires_at`
- bounded `error_code` and safe `error_summary`
- `checked_at`, `created_at`, and `updated_at`
- unique `(run_id, company_id)`

An expired lease is resumable. A request may not lease an item currently held
by another request.

### 6.3 `founder_research_run_people`

- `id` UUID primary key
- `run_item_id` foreign key
- `person_id` foreign key to the existing `people` row
- `identity_status`: `VERIFIED`, `CANDIDATE`, or `CONFIRMED`
- `founder_role_match`: the normalized founder/CEO role rule that matched
- `confidence` from 0 through 1
- `created_at` and `updated_at`
- unique `(run_item_id, person_id)`

An official-source person is saved through the existing people and evidence
repositories before this association is created. A public-search founder
candidate is saved with candidate evidence and `identity_status=CANDIDATE`.
Manual confirmation changes the association but does not delete its original
evidence.

### 6.4 `founder_profile_candidates`

- `id` UUID primary key
- `run_person_id` foreign key
- `owner_subject` UUID
- normalized `profile_url`
- `status`: `VERIFIED`, `CANDIDATE`, `CONFIRMED`, or `REJECTED`
- `source_kind`: `OFFICIAL_YC`, `OFFICIAL_COMPANY`, `PUBLIC_SEARCH`, or
  `MANUAL_CONFIRMATION`
- exact `search_query` when source kind is `PUBLIC_SEARCH`
- public `evidence_url`, bounded `evidence_title`, and bounded
  `evidence_snippet`
- `checked_at`
- confidence from 0 through 1
- `created_at` and `updated_at`
- unique `(owner_subject, run_person_id, profile_url)`

The normalized URL must:

- use HTTPS;
- have host `linkedin.com` or a subdomain of `linkedin.com`;
- have a `/in/<slug>` path;
- contain no username, password, fragment, or non-default port;
- be at most 2,048 characters and 4,096 UTF-8 bytes.

Validation is syntactic and contextual only. It performs no DNS lookup and no
HTTP request to LinkedIn.

### 6.5 `founder_profile_confirmation_events`

Append-only audit records:

- `id` UUID primary key
- `candidate_id` foreign key
- `owner_subject` UUID
- `event`: `CONFIRMED` or `REJECTED`
- optional bounded note
- `created_at`

The candidate state transition and event insert occur in one serializable
transaction. Confirmation of one candidate rejects no other candidate
silently; the service returns remaining ambiguity for explicit resolution.

### 6.6 `founder_research_exports`

- `id` UUID primary key
- `run_id` foreign key
- `owner_subject` UUID
- `state`: `READY`, `EXPIRED`, or `DELETED`
- `file_name`
- MIME type
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `byte_size` with a five-megabyte upper bound
- SHA-256 checksum
- workbook bytes in a private `bytea` column
- row and sheet counts
- `created_at` and `expires_at`

The workbook is small for a 50-company run, and storing the exact bytes in the
private application schema avoids a new public bucket, a service-role key, or
direct mutation of the Supabase Storage schema.

### 6.7 `founder_export_download_capabilities`

- `id` UUID primary key
- `export_id` foreign key
- `owner_subject` UUID
- SHA-256 token hash; never the raw token
- `expires_at`
- `created_at` and `last_downloaded_at`

Capabilities may be used more than once during their 15-minute lifetime so a
browser preflight or interrupted download does not consume the only attempt.
They cannot outlive the underlying export.

## 7. Founder and URL matching rules

Founder-like roles include explicit founder, co-founder, founding CEO, CEO and
co-founder, and equivalent punctuation or capitalization variants.

`CEO` without a founder term is retained only when:

- the official YC record identifies the same person as a founder; or
- at least one other public source explicitly identifies the person as a
  founder.

Name matching:

- uses Unicode NFC normalization and whitespace normalization;
- allows reordered given/family names only when all tokens match;
- never treats initials alone as a match;
- never merges two people solely because they share a name;
- requires company context for a public-search candidate.

Company matching accepts the official company name and explicit known aliases
from the YC record. A candidate based only on an unrelated same-name company
is rejected.

## 8. MCP tools

All tools require the existing Supabase OAuth identity and enforce
`owner_subject` server-side. Stable identifiers and structured output are
returned; credentials, raw capabilities, and internal diagnostics are not.

### 8.1 `start_yc_founder_research`

Private reversible write.

Inputs:

- optional existing YC filters;
- `limit`, default 50 and maximum 50;
- `excludeResearchedWithinDays`, default 30 and maximum 365.

Behavior:

- queries the authoritative YC provider;
- deterministically selects at most `limit` companies;
- excludes companies with fresh completed evidence when requested;
- creates the run and all immutable run items transactionally;
- returns the run summary and first processing recommendation.

It does not research company pages in the same call.

### 8.2 `process_yc_founder_research`

Private reversible write.

Inputs:

- `runId`;
- `maxCompanies`, default 5 and maximum 5.

Behavior:

- leases up to five pending or expired items;
- processes at most two companies concurrently;
- reuses current people-discovery request, page, and elapsed-time budgets;
- identifies founder-like people;
- saves official evidence and exact official profile links;
- marks partial failures without aborting the run;
- returns completed results and bounded public-search tasks for unresolved
  people or companies.

Repeated calls resume until no processable item remains. The result tells
ChatGPT whether to call this tool again, perform public search, or export.

### 8.3 `save_founder_profile_candidates`

Private reversible write.

Inputs:

- `runId`;
- up to 25 candidate entries containing company ID, person ID or bounded
  candidate name and role, candidate profile URL when found, exact search
  query, evidence URL, title or snippet, checked time, and confidence.

Behavior:

- verifies the company belongs to the run;
- validates identity, company context, URL syntax, evidence fields, freshness,
  and deduplication;
- records candidate people and URLs without fetching LinkedIn;
- never changes a verified or confirmed canonical URL;
- recalculates run-item and run state.

A candidate submission with no LinkedIn URL may still save a founder identity
and mark the profile state `NOT_FOUND`.

### 8.4 `confirm_founder_profile_candidate`

Private reversible write with an audit event.

Inputs:

- `candidateId`;
- `decision`: `CONFIRM` or `REJECT`;
- optional note.

Behavior:

- verifies ownership and current state;
- records the append-only event;
- promotes the associated founder identity when confirmed;
- mirrors a confirmed canonical URL into the existing
  `people.public_profile_url` compatibility field;
- returns any remaining ambiguity.

It does not open LinkedIn or send anything.

### 8.5 `save_founder_outreach_batch`

Private reversible write.

Inputs:

- `runId`;
- up to 25 entries containing person ID, target scoring fields, evidence IDs,
  personalization rationale, connection-note text, and review state
  `READY_TO_REVIEW` or `NEEDS_REVIEW`.

Behavior:

- requires every factual personalization to be supported by saved evidence;
- reuses the existing target upsert and versioned outreach-draft records;
- uses purpose `linkedin_connection_request`;
- rejects invented details, unsupported praise, private personal data, and
  claimed prior relationships without evidence;
- limits a connection note to 200 Unicode characters;
- saves a new immutable draft version instead of overwriting prior text.

The 200-character limit follows LinkedIn's current personalized-invitation
guidance and must be covered by a dated contract test. If LinkedIn changes the
documented limit, the constant and test are updated through a reviewed change.

### 8.6 `export_founder_research_workbook`

Private reversible write and render tool.

Inputs:

- `runId`;
- optional `includeCandidateUrls`, default true.

Behavior:

- reloads the complete owner-scoped run snapshot;
- creates the exact workbook bytes;
- validates sheet names, columns, counts, formulas, strings, size, and ZIP
  structure;
- stores bytes, checksum, expiry, and metadata;
- creates a 15-minute download capability;
- returns only safe export metadata in model-visible structured content;
- returns the raw download URL only in widget-private tool-result metadata;
- renders the private export card.

The card has a single **Download Excel** control and shows run ID, created time,
expiry, row counts, and checksum prefix. It cannot research, mutate candidates,
contact LinkedIn, or send a message.

## 9. Workbook contract

The workbook contains exactly four sheets in this order.

### 9.1 `Ready to Review`

Rows with a `VERIFIED` or `CONFIRMED` profile URL and a saved outreach draft.

Columns:

1. Company
2. YC Batch
3. Company Status
4. Hiring
5. Company Website
6. Founder
7. Founder Role
8. LinkedIn URL
9. URL Status
10. Profile Evidence
11. Checked At
12. Confidence
13. Personalization Rationale
14. Draft Connection Note
15. Note Review Status
16. Outreach Status
17. Person ID
18. Target ID
19. Draft ID

### 9.2 `Needs Verification`

Founder identities or URLs in `CANDIDATE` or `AMBIGUOUS` state. It includes the
same identifying columns plus search query, evidence URL, evidence snippet,
and required manual action. Candidate URLs are plainly labeled and are never
presented as verified.

### 9.3 `Not Found - Failed`

Companies whose founder or profile URL was not found, plus item failures and
safe error summaries. It contains no stack traces, credentials, or raw HTTP
responses.

### 9.4 `Run Summary`

- run filters and timestamps;
- selected and processed counts;
- counts by result state;
- evidence freshness policy;
- workbook checksum;
- the statement: `Connection requests must be reviewed and sent manually on
  LinkedIn.`

Workbook safety rules:

- user-controlled cells beginning with `=`, `+`, `-`, or `@` are escaped as
  text to prevent spreadsheet formula injection;
- URLs are written as text, not executable formulas;
- no macros, external workbook links, hidden sheets, hidden rows, or remote
  images;
- freeze panes and filters improve review but do not alter data;
- output order is deterministic by company name, founder name, and stable ID;
- timestamp and numeric cells use fixed explicit formats.

## 10. Private download route

The application exposes an owner-scoped HTTPS route:

`GET /research-exports/:exportId/download?capability=<opaque-token>`

The route:

1. validates token shape before hashing;
2. loads the matching token hash and export;
3. checks owner, export state, both expiries, checksum, byte count, and MIME
   type;
4. updates `last_downloaded_at`;
5. sends the exact stored bytes with `Content-Disposition: attachment`;
6. sets `Cache-Control: private, no-store`, `Pragma: no-cache`,
   `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`;
7. emits only a safe not-found response for malformed, expired, wrong-owner,
   or mismatched requests.

The raw capability is never logged. Request logging redacts the query value.
The export card also sets a no-referrer policy.

## 11. Error and resume behavior

One company failure never aborts other leased items.

Run-item outcomes:

- `COMPLETE`: founder identity is official or confirmed and profile is
  verified or confirmed.
- `PARTIAL`: founder identity is usable but profile URL or outreach draft is
  missing.
- `NOT_FOUND`: no founder identity or profile candidate was found.
- `AMBIGUOUS`: multiple candidates remain.
- `FAILED`: processing could not produce a safe result after the bounded
  attempt.

Safe error codes distinguish:

- official source unavailable;
- unsupported page layout;
- request or elapsed-time budget exhausted;
- stale evidence;
- public-search evidence invalid;
- LinkedIn URL syntax invalid;
- identity or company mismatch;
- stale candidate decision;
- unsupported personalization;
- workbook generation or integrity failure;
- export expired.

Raw network errors and stack traces remain server-side and are redacted before
logging.

## 12. Security and policy boundaries

- The current least-privilege `career_mcp_runtime` Postgres role remains the
  only production application database identity.
- No Supabase service-role or secret key is introduced.
- New data stays in the unexposed `career_mcp` schema.
- Every repository method accepts or derives the authenticated subject and
  scopes all new records to it.
- Tool annotations reflect actual behavior: reads are read-only; run,
  candidate, outreach, and export writes are private and non-destructive; no
  tool has a LinkedIn external-write side effect.
- The server instruction explicitly states that research exports do not
  authorize connection automation.
- The feature complies with the existing non-fetching LinkedIn URL type: a
  profile URL is data only and can never enter the public-page fetch adapter.

Supabase's current guidance requires RLS on exposed-schema tables and describes
RLS as defense in depth. These records are instead kept in the private schema
with explicit runtime-role privileges; no direct browser database access is
added. Supabase also documents that private Storage would require RLS or signed
URLs, but version one deliberately keeps the small workbook bytes in private
Postgres and does not add another bucket.

OpenAI's current tool-planning guidance requires explicit contracts, stable
identifiers, structured results, correct read/write annotations, and keeping
secrets and access tokens out of results. The export tool therefore exposes
only safe metadata to the model and gives the download capability only to the
rendered card through private tool-result metadata.

## 13. Testing strategy

Implementation follows test-driven development.

### 13.1 Founder discovery

- official team, leadership, about, and JSON-LD variants;
- founder/co-founder role variants;
- CEO-only false-positive controls;
- missing founder and missing profile;
- multiple founders;
- multiple same-name people;
- unrecognized layouts;
- malformed and oversized fields;
- stale source evidence;
- partial page failures;
- per-company request and elapsed-time budgets;
- proof that no LinkedIn URL reaches the fetch transport.

### 13.2 Public-search candidates

- valid `/in/` URL and company context;
- wrong host, HTTP, credentials, port, fragment, non-profile path, excessive
  length, homoglyph, and malformed URL rejection;
- missing search evidence;
- stale or future checked times;
- wrong company and wrong person rejection;
- deduplication;
- multiple candidates and ambiguity;
- verified and confirmed precedence;
- manual confirm, reject, stale decision, and cross-owner denial.

### 13.3 Run coordination

- deterministic selection up to 50;
- fresh-result exclusion;
- immutable membership;
- five-item leases and lease expiry;
- two-company concurrency bound;
- partial failure isolation;
- interruption and resume;
- idempotent repeated processing;
- exact counters and terminal state;
- simultaneous processor race tests.

### 13.4 Outreach

- evidence-backed drafts;
- unsupported factual personalization rejection;
- invented relationship or metric rejection;
- 200-character boundary including Unicode;
- immutable draft versioning;
- existing target and pipeline compatibility;
- batches of 25 and duplicate entries.

### 13.5 Workbook and download

- exact four sheets and column order;
- row placement by state;
- deterministic sorting;
- formula-injection escaping;
- no formulas, macros, hidden content, or external links;
- Excel-compatible dates, links, and Unicode;
- exact row and summary counts for a 50-company fixture;
- byte-size limit and SHA-256 verification;
- stored bytes equal downloaded bytes;
- model-visible result excludes capability and workbook bytes;
- widget-private result contains only the short-lived download URL;
- malformed, expired, wrong-owner, wrong-export, and checksum-mismatch denial;
- query-token redaction and no-store response headers;
- export and capability expiry cleanup.

### 13.6 Regression and production validation

- all existing tests;
- typecheck and production build;
- dependency and production vulnerability audit;
- Postgres migration and repository integration tests;
- database lint and security advisor review;
- Docker build and health/readiness checks;
- authenticated ChatGPT connector smoke test;
- read-only live pilot with 10 YC companies;
- read-only live pilot with 50 YC companies after the 10-company pilot passes;
- manual inspection of false positives, false negatives, candidate quality,
  workbook contents, and download expiry.

The live pilots create no LinkedIn connection request, message, preview, media
upload, or post.

## 14. Rollout

1. Implement and verify locally in the isolated
   `codex/founder-research-export` branch.
2. Apply the reviewed migration to the existing `PMM-MCP` Supabase project.
3. Deploy that branch to the existing Railway service.
4. Refresh the PMM Career MCP connector so ChatGPT discovers the new tools and
   export card.
5. Run the 10-company live pilot.
6. Fix material accuracy or safety issues before the 50-company pilot.
7. Run the 50-company pilot and inspect the workbook manually.
8. Add the daily ChatGPT schedule only after both pilots pass.

Production completion means the researched records survive a restart, the
private workbook downloads correctly, candidate states are honest, and every
LinkedIn connection remains a manual user action.

## 15. Primary references

- [OpenAI: Define tools](https://developers.openai.com/apps-sdk/plan/tools)
- [OpenAI: Build your ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: Storage bucket access models](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [LinkedIn: Personalize invitations to connect](https://www.linkedin.com/help/linkedin/answer/a567201)
- [LinkedIn: Prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387)
- [LinkedIn: Automated activity](https://www.linkedin.com/help/linkedin/answer/a1340567)
- [LinkedIn: Invitation restrictions](https://www.linkedin.com/help/linkedin/answer/a551012)
