# Task 7 Claim Ledger Privileges Implementation Plan

> **For Codex:** Execute this plan in the existing `codex/supabase-migration`
> feature branch. Do not run live Supabase commands and do not modify
> `.superpowers/sdd/progress.md`.

**Goal:** Prevent the runtime database role from directly mutating the branded
media claim ledger while preserving trigger-managed claims and conflict
enforcement.

**Architecture:** Keep ordinary application-table privileges unchanged, then
apply a ledger-specific deny after both current-table and default-privilege
grants. Move the two trigger functions to migration-owner `SECURITY DEFINER`
execution with an empty search path, fully qualified objects, and explicitly
restricted function execution. Validate both SQL ordering and real PostgreSQL
role behavior behind the existing acknowledged loopback-only test gate.

**Tech Stack:** PostgreSQL/Supabase SQL, Drizzle migrations, Vitest, postgres.js.

## Task 1: Add failing privilege regressions

**Files:**
- Modify: `tests/db/runtime-role.test.ts`
- Modify: `tests/db/schema-hardening.test.ts`
- Modify: `tests/db/brand-media-concurrency.integration.test.ts`

1. Assert the runtime-role script revokes claim-ledger mutation privileges
   after its broad current/default grants and grants only ledger SELECT plus
   trigger-function EXECUTE.
2. Assert both claim trigger functions are `SECURITY DEFINER`, use an empty
   search path and qualified objects, revoke PUBLIC execution, and are not
   owned by the runtime role.
3. Add a guarded real-PostgreSQL regression that installs/reruns the runtime
   role script, uses `SET LOCAL ROLE career_mcp_runtime`, proves direct claim
   INSERT/UPDATE/DELETE/TRUNCATE fail, and proves attachment/source writes still
   create claims and enforce conflicts.
4. Run the focused tests and confirm they fail for the missing hardening.

## Task 2: Harden SQL and verify

**Files:**
- Modify: `supabase/runtime-role.sql`
- Modify: `drizzle/0005_brand_source_media_exclusive.sql`
- Modify: `.superpowers/sdd/task-7-report.md`

1. Add an order-safe, idempotent ledger-specific privilege block to
   `runtime-role.sql`, conditional on the migration objects existing.
2. Make both trigger functions migration-owner `SECURITY DEFINER` functions
   with `SET search_path = ''`, qualified relations, PUBLIC execution revoked,
   and a conditional minimum EXECUTE grant to the runtime role.
3. Revoke runtime claim-ledger mutations in the migration as well so either
   provisioning order remains secure.
4. Run focused tests, typecheck, Drizzle checks, and the full test suite once.
5. Append the security result to the Task 7 report, confirm progress remains
   untouched, commit the focused changes, and report the commit.
