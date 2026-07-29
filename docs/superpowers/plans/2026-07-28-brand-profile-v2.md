# Brand Profile V2 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the legacy `PMM FIELD NOTES` identity from every newly generated LinkedIn visual package without altering historical draft provenance.

**Architecture:** Introduce an immutable brand-profile version 2 using the internal series identity `EDITORIAL INTELLIGENCE`. A PostgreSQL data migration retires active canonical version-1 profiles and creates active version-2 profiles while preserving the version-1 rows referenced by historical briefs and media. Application defaults and repository writes then target version 2, while the renderer continues to display only the approved headline, topic label, monogram, name, and role.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL/Supabase, PGlite, Vitest, MCP, Railway

---

### Task 1: Lock the regression behavior in tests

**Files:**
- Modify: `tests/brand/brief-service.test.ts`
- Modify: `tests/brand/render-service.test.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/db/schema-hardening.test.ts`

- [ ] Update brand-profile and provenance expectations to version 2 and `EDITORIAL INTELLIGENCE`.
- [ ] Add a migration regression test proving version 1 is preserved and retired while version 2 becomes active.
- [ ] Run the focused tests and confirm they fail for the expected missing implementation.

### Task 2: Implement application brand profile version 2

**Files:**
- Modify: `src/brand/profile.ts`
- Modify: `src/brand/brief-service.ts`
- Modify: `src/db/repositories.ts`

- [ ] Change the canonical application profile to version 2 and the new internal series identity.
- [ ] Pass the profile version through repository inputs instead of hard-coding version 1.
- [ ] Keep the public visual renderer free of any series-name label.

### Task 3: Add the immutable PostgreSQL data migration

**Files:**
- Create: `drizzle/0008_brand_profile_v2.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] Retire only canonical active version-1 `PMM FIELD NOTES` profiles.
- [ ] Create one active version-2 `EDITORIAL INTELLIGENCE` profile per migrated owner.
- [ ] Preserve old profile IDs, versions, and historical foreign-key references.
- [ ] Make the migration safe to re-run through guarded inserts.

### Task 4: Verify the complete application

**Files:**
- Test: `tests/brand/brief-service.test.ts`
- Test: `tests/brand/render-service.test.ts`
- Test: `tests/mcp/tools.test.ts`
- Test: `tests/db/schema-hardening.test.ts`

- [ ] Run focused regression tests.
- [ ] Run the complete automated test suite.
- [ ] Run typecheck and production build.
- [ ] Build the production Docker image.

### Task 5: Release and verify production

**Files:**
- Modify only if verification identifies a release-specific problem.

- [ ] Commit the verified changes on `codex/supabase-migration`.
- [ ] Push the branch to GitHub.
- [ ] Deploy the verified source to the existing Railway production service.
- [ ] Confirm the deployment succeeds and the MCP exposes a valid action schema.
- [ ] Confirm a new brand-profile read no longer returns `PMM FIELD NOTES`.
- [ ] Give the user the exact ChatGPT refresh and scheduled-task reactivation steps.
