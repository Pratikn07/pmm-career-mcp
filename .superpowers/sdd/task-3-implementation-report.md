# Task 3 Implementation Report

## Status

Complete. PostgreSQL transaction, concurrency, rollback, and publishing-order invariants are implemented and verified on `codex/supabase-migration`.

## Scope

Changed only the Task 3 repository, preview, publish, and focused test files, plus this report. No cloud, Auth, deployment documentation, or real LinkedIn integration was touched. Publishing remains disabled by configuration unless explicitly enabled elsewhere.

## Implementation

- Added a bounded PostgreSQL SERIALIZABLE transaction helper with three total attempts and short 5 ms / 15 ms delays.
- Retries SQLSTATE `40001` and `40P01`; retries `23505` only when `constraint_name` exactly matches `post_draft_version_unique` or `outreach_target_purpose_version_unique` for the relevant allocator.
- Outreach allocation locks the parent target row and latest matching draft row. Post allocation locks the latest logical-draft row; empty sequences are protected by SERIALIZABLE plus the named unique-conflict retry.
- Discovery refresh locks the company row and replaces people/evidence inside one SERIALIZABLE transaction.
- Preview creation locks the latest post row in a SERIALIZABLE transaction, so a concurrent revision has a valid serial order.
- Preview consumption locks the preview and exact post rows, conditionally updates `consumed_at`, and claims the exact state in one transaction.
- The publishing overload of `publishAttempts.record` now performs preview consumption, exact post-state claim, exact claim/attempt identity validation, and durable attempt insertion in one SERIALIZABLE transaction. Any claim or attempt failure rolls the entire unit back.
- Publishing still performs exactly one external fake-client call, only after the atomic claim/attempt transaction commits, and awaits both completion writes before resolving.

## TDD evidence

1. Clean baseline: `npm test` passed 26 files / 368 tests.
2. RED 1: focused suites reported 54 passing and 1 failing test. A rejected pending-attempt insert left preview `consumed_at` set, proving the claim committed too early.
3. GREEN 1: atomic claim plus attempt implementation made the publish suite pass 7/7 and typecheck pass.
4. RED 2: retry-policy tests reported four expected failures because version allocators called the transaction only once for `40001`, `40P01`, and the two named `23505` constraints.
5. GREEN 2: SERIALIZABLE locking and bounded retry implementation made all focused tests pass.
6. Self-review RED/GREEN: a mismatched valid attempt target initially resolved as `recorded`; an exact claim/attempt identity guard made the regression pass and proved rollback.

## Verification

- Focused: `npm test -- tests/db/repositories.test.ts tests/posts/preview-service.test.ts tests/linkedin/publish-service.test.ts` — 3 files, 67 tests passed.
- Full: `npm test` — 26 files, 387 tests passed.
- Typecheck: `npm run typecheck` — passed.
- `git diff --check` — passed.

## Self-review and concerns

- Reviewed lock ordering, empty/existing version sequences, checksum allocation, retry bounds/classification, exact-version identity, rollback paths, and external-call ordering. No unresolved critical or important finding remains.
- PGlite validates constraints and control flow but uses a single in-process client. Production safety comes from explicit SERIALIZABLE transactions, row locks, conditional updates, named constraints, and bounded retries rather than PGlite scheduling.
- A fresh reviewer subagent could not be started because the task tree had reached its agent-thread limit; the required self-review and all verification gates were completed locally.
- No live PostgreSQL/Supabase or LinkedIn call was made, as required.
