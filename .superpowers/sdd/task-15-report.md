# Task 15 Production Verification and Rollout

## Outcome

The YC founder research and private Excel export workflow is deployed and
healthy in production from `codex/founder-research-export`.

- Source commit: `8582b061c243e66dc3c57659e8e6563933eec96c`
- Railway deployment: `9f96ae9d-220b-42f8-976c-0ab6e47cb0f0`
- Production service: `https://pmm-career-mcp-production.up.railway.app`
- `/health`: healthy
- `/ready`: ready
- Railway plan: hobby; no plan or billing change was made
- Production builder: repository Dockerfile

## Database verification

Supabase project `jcurllwupihgkmcrydms` is current through founder-research
migration `0011`.

- Local and remote migration journals matched with zero pending migrations.
- All seven founder-research tables, 48 expected constraints, and 17 expected
  indexes were present.
- The private runtime role had the intended schema/table privileges.
- `PUBLIC`, `anon`, `authenticated`, and `service_role` had no unintended
  founder-table grants.
- The private schema was not exposed through the Supabase Data API.
- Live create/read/update/delete smoke operations passed inside a transaction
  and rolled back without leaving marker rows.
- No credential, database URL, token, capability, or workbook bytes were
  printed.

## Production pilot evidence

### Corrected 10-company pilot

- Selected 10 unique YC companies.
- Processed them in two calls of five with at most two concurrent official-site
  checks.
- Preserved all 10 as durable `NEEDS_PUBLIC_SEARCH` work.
- Created and reopened a 10-row workbook.
- Verified the exact four sheets: `Ready to Review`, `Needs Verification`,
  `Not Found - Failed`, and `Run Summary`.
- Workbook CRC, stored checksum, tool checksum, row count, selected count, and
  processed count all matched.
- Made zero LinkedIn network requests and performed no candidate decision,
  outreach, invitation, message, or publication.

### 50-company pilot

- Selected 50 unique YC companies.
- Processed them in ten calls of five with maximum official-site concurrency of
  two.
- Recorded 50 unique memberships, zero duplicates, and one lease attempt per
  company.
- Preserved all 50 as durable `NEEDS_PUBLIC_SEARCH` work with no pending or
  leased items.
- Created and reopened a 50-row workbook with the exact four sheets.
- Workbook CRC, checksums, row count, selected count, and processed count all
  matched the database.
- Made zero LinkedIn network requests and performed no candidate decision,
  outreach, invitation, message, or publication.

The pilot does not claim automatic founder coverage. YC and official company
pages did not provide enough trusted founder/profile evidence for these samples,
so the correct safe result was to queue public-web candidate searches for
ChatGPT and require the user to review every candidate before confirmation.

## Live issues found and fixed

1. Some live company records contained malformed, non-HTTPS, or credentialed
   website values. The export now omits those unsafe values while preserving
   valid credential-free HTTPS URLs. The workbook is reopened in tests to prove
   the saved XML contains only safe values.
2. The workbook summary previously derived selected/processed values from output
   rows. It now uses the validated persisted run counters. In particular,
   `NEEDS_PUBLIC_SEARCH` is durable outstanding work but is not counted as
   processed.

Both fixes were independently reviewed with no Critical, Important, or Minor
findings.

## Final release gate

- Automated tests: 1,490 passed, 5 guarded skips, 1,495 total.
- Test files: 72 passed.
- Coverage: 86.61% statements, 82.44% branches, 92.44% functions, 87.45% lines.
- Typecheck: passed.
- Server, consent, LinkedIn review-card, and founder export-card builds: passed.
- Production dependency audit: 0 vulnerabilities.
- Docker build: passed.
- Container runtime import smoke for JSZip and Sharp: passed.
- Git diff check: passed.
- Publishing configuration remained enabled for text and images. The founder
  workflow exposed no publish operation and published nothing.

## Remaining operator action

In ChatGPT, open the PMM Career MCP plugin settings and use **Refresh** so the
connector scans the six new founder-research tools and founder export card.
Then run the safe prompt documented in `README.md`. LinkedIn profile review and
the final **Connect** action remain manual.
