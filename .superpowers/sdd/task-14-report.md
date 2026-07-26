# Task 14 report — founder-research operation documentation

## Outcome

Documented the private YC founder-research workflow, retention, export-card
use, manual LinkedIn boundary, deployment release boundary, migration journal,
connector verification, expired-artifact cleanup, and rollback procedure.
The documentation makes no claim of complete founder coverage, verified
public-search candidates, or automated outreach.

## Files changed

- `README.md`
- `docs/deployment/supabase-railway-chatgpt.md`
- `.superpowers/sdd/task-14-report.md`

No production source, database migration, Dockerfile, or test file changed.

## Documentation requirement checklist

- Safe copy-pasteable daily ChatGPT prompt with no secrets or sample
  credentials: satisfied.
- Prompt starts/advances a private run, processes repeated calls of at most
  five companies, stops at public-search or terminal/export instructions, and
  saves public-web findings only as candidates without opening LinkedIn:
  satisfied.
- Prompt stops for the user's candidate decisions, saves only evidence-backed
  private notes of at most 200 Unicode code points, exports/opens the private
  card, and stops without LinkedIn interaction: satisfied.
- Candidate `CONFIRM`/`REJECT` semantics and manual inspection are explicit;
  `CONFIRMED` is a user decision, candidates are unverified, and rejected
  candidates remain audit/unresolved history: satisfied.
- Workbook's four sheets, canonical-database regeneration, 30-day evidence
  freshness, seven-day artifact expiry, and 15-minute capability expiry:
  satisfied.
- Manual LinkedIn opening/review and manual **Connect**/later invitation are
  explicit. MCP/ChatGPT LinkedIn fetching, scraping, browser automation,
  Connect, invitations, requests, and messages are prohibited: satisfied.
- Migration journal is named from the committed `drizzle/meta/_journal.json`;
  deployment is only from `codex/founder-research-export`, never `main`, and
  no paid plan or upgrade is authorized: satisfied.
- Connector refresh/rescan requires exactly the six founder tools and the
  private export card's **Download Excel** control without exposing its
  capability: satisfied.
- Expired-artifact/capability cleanup and service-first, history-preserving
  rollback guidance are included without secrets: satisfied.

## Checks

```text
npx vitest run tests/build/dockerfile.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)

npm run typecheck
tsc --noEmit (passed)

npm run build
build:server, build:consent, build:review-card, and build:founder-export-card
all passed

git diff --check
passed with no whitespace errors
```

The final review also uses a targeted case-insensitive search of `README.md`
and `docs/deployment/supabase-railway-chatgpt.md` for complete-coverage,
verified-candidate, automated-outreach, Connect, invitation, and messaging
claims. Matches are either explicit prohibitions or the new documentation that
rejects those misleading interpretations.

## Misleading-claim scrub result

Current README and deployment/runbook guidance now expressly says that founder
coverage is not complete, public-search candidates are not verified, and
outreach is not automated. No current user/operator claim was found that
promises complete coverage, verifies a public-search candidate, or authorizes
automated LinkedIn outreach. Historical plan and design records were not
rewritten.

## No live action

No live migration, Supabase call, Railway deployment, connector refresh,
pilot, branch push, paid-plan request, LinkedIn fetch, scraping, browser
automation, profile opening, Connect click, invitation, connection request,
or message was performed.

## Progress-file preservation

`.superpowers/sdd/progress.md` was already modified before this task. It was
not read, edited, staged, restored, or committed. Initial and final status
review preserved it as the separate unstaged modification; the staged-scope
review excludes it.

## Commit

The intended documentation commit subject is:

```text
docs: explain founder research workflow
```

The content-addressed final SHA is supplied in the task handoff rather than
self-referenced inside this committed report.

## Concerns

The known fixed-clock baseline remains outside this documentation task: broader
candidate/outreach tests can fail after their fixed July 25 timestamps fall
behind newly created database rows on July 26. This task did not modify those
tests, services, timestamps, or database constraints.

## Precise Task 15 handoff

1. Read current Supabase migration/Postgres guidance before any live action.
2. Complete local verification, including a clean migration test and a
   maximum-size workbook reopen check.
3. Use the existing private production migration path only. Pause for the
   user if a password or other secret entry is required; never print or store
   it.
4. Push and deploy only `codex/founder-research-export`, never `main`; do not
   request or initiate a paid upgrade.
5. Refresh the connector, confirm exactly the six founder tools and private
   export card, and keep capability values private.
6. Run the read-only 10-company pilot before the bounded 50-company pilot.
   Advance the latter with repeated calls of at most five companies and stop
   for user review of candidate decisions.
7. Keep LinkedIn fully manual: the user alone opens/reviews profiles, clicks
   **Connect**, and later sends any invitation. MCP/ChatGPT must not fetch or
   scrape LinkedIn, automate a browser, click Connect, send requests, or send
   messages.
