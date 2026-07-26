# Editorial Intelligence Review Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic Editorial Model/Evidence images and a combined Daily Brief → draft → image → review-controls package to PMM Career MCP.

**Architecture:** Store validated structured visual content with each branded brief, render deterministic 1080×1350 SVG/PNG cards from that content, and pass an optional concise daily brief into the existing read-only review-card launcher. Enforce package completeness with an expected image count while preserving the existing exact-preview and explicit-publish safeguards.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, Supabase Postgres, Resvg, Sharp, MCP SDK, Vitest

## Global Constraints

- The scheduled run must never create an exact LinkedIn preview, upload to LinkedIn, create an authorization URL, or publish.
- The draft → image → review-package sequence runs only when the daily decision is `POST CANDIDATE`; other decisions stop without manufacturing a post.
- `PMM FIELD NOTES` must not appear in newly rendered images or the review UI.
- The stable footer is `BN`, `BHAGYASHREE NANDOSKAR`, and `PRODUCT MARKETING`.
- `EDITORIAL_MODEL` uses exactly three numbered stages with two or three short bullets per stage.
- Required images must be rendered and attached before the review package opens.
- Existing statement/metaphor drafts and review cards remain compatible.
- No invented personal experience, metrics, quotes, or evidence.

---

### Task 1: Structured editorial content and persistence

**Files:**
- Create: `src/brand/content.ts`
- Modify: `src/brand/profile.ts`
- Modify: `src/brand/templates.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories.ts`
- Create: `drizzle/0007_editorial_intelligence.sql`
- Create: `supabase/migrations/20260726000000_editorial_intelligence.sql`
- Test: `tests/brand/content.test.ts`
- Test: `tests/db/schema-hardening.test.ts`

**Interfaces:**
- Produces: `BrandVisualContent`, `EditorialModelContent`, `EditorialEvidenceContent`, and `validateBrandVisualContent(mode, value)`.
- Produces: `brand_visual_briefs.visual_content_json`.
- Produces: templates `editorial-model-v1` and `editorial-evidence-v1`.

- [ ] **Step 1: Write failing content-contract tests**

Add tests proving that model content requires exactly stages `01`, `02`, `03`, two or three items per stage, bounded single-line text, and that statement/metaphor reject structured content.

- [ ] **Step 2: Run the content tests and confirm RED**

Run: `npx vitest run tests/brand/content.test.ts`

Expected: FAIL because the content module and new modes do not exist.

- [ ] **Step 3: Implement the content types and validation**

Create `src/brand/content.ts`, extend `BrandVisualMode`, add model/evidence templates, and return deeply frozen normalized content.

- [ ] **Step 4: Run the content tests and confirm GREEN**

Run: `npx vitest run tests/brand/content.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing schema tests**

Assert that the database accepts the four visual modes and contains nullable JSONB `visual_content_json`.

- [ ] **Step 6: Run schema tests and confirm RED**

Run: `npx vitest run tests/db/schema-hardening.test.ts`

Expected: FAIL because the column and mode constraint are absent.

- [ ] **Step 7: Add Drizzle and Supabase migrations**

Add the nullable JSONB column, replace the mode check with all four modes, and keep legacy rows valid.

- [ ] **Step 8: Run schema tests and confirm GREEN**

Run: `npx vitest run tests/db/schema-hardening.test.ts`

Expected: PASS.

### Task 2: Editorial Model and Evidence renderer

**Files:**
- Modify: `src/brand/renderer.ts`
- Modify: `src/brand/prompt.ts`
- Test: `tests/brand/renderer.test.ts`
- Test: `tests/brand/prompt.test.ts`

**Interfaces:**
- Consumes: `BrandVisualContent` and the new templates.
- Produces: deterministic model/evidence SVG and 1080×1350 PNG output.

- [ ] **Step 1: Write failing renderer tests**

Add tests asserting that model SVG contains the approved hook, subhead, three numbered stages, short bullets, evidence line, and stable footer; assert that it does not contain `PMM FIELD NOTES`.

- [ ] **Step 2: Run renderer tests and confirm RED**

Run: `npx vitest run tests/brand/renderer.test.ts`

Expected: FAIL because the new renderer modes are unsupported.

- [ ] **Step 3: Implement deterministic model/evidence layouts**

Extend renderer input with `visualContent`, add safe text measurement and fixed regions for both formats, omit the legacy series label, and retain statement/metaphor behavior.

- [ ] **Step 4: Run renderer tests and confirm GREEN**

Run: `npx vitest run tests/brand/renderer.test.ts`

Expected: PASS.

- [ ] **Step 5: Update and test prompt copy**

Rename public copy from “PMM Field Notes” to “Bhagyashree Editorial Intelligence” and make model/evidence briefs explicitly deterministic with no source-art requirement.

- [ ] **Step 6: Verify prompt tests**

Run: `npx vitest run tests/brand/prompt.test.ts`

Expected: PASS.

### Task 3: Brief and render services

**Files:**
- Modify: `src/brand/brief-service.ts`
- Modify: `src/brand/render-service.ts`
- Modify: `src/db/repositories.ts`
- Test: `tests/brand/brief-service.test.ts`
- Test: `tests/brand/render-service.test.ts`
- Test: `tests/db/repositories.test.ts`

**Interfaces:**
- Consumes: `visualContent` in `CreateBrandVisualBriefInput`.
- Produces: persisted structured briefs and immutable post versions containing the rendered image.

- [ ] **Step 1: Write failing service tests**

Add a model-brief test using the approved Understand → Translate → Execute content and a render test proving that it attaches one deterministic PNG without source art.

- [ ] **Step 2: Run service tests and confirm RED**

Run: `npx vitest run tests/brand/brief-service.test.ts tests/brand/render-service.test.ts`

Expected: FAIL because services reject the new mode/content.

- [ ] **Step 3: Implement brief persistence and rendering**

Validate and store structured content, pass it into the renderer, remove visible series wording from alt text/provenance copy, and preserve immutable version/checksum behavior.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run: `npx vitest run tests/brand/brief-service.test.ts tests/brand/render-service.test.ts tests/db/repositories.test.ts`

Expected: PASS.

### Task 4: MCP contracts and scheduled workflow instructions

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/tools.test.ts`
- Test: `tests/mcp/annotations.test.ts`

**Interfaces:**
- Produces: `create_branded_visual_brief.visualContent`.
- Produces: `open_linkedin_review_card.dailyBrief` and `expectedImageCount`.
- Produces: model instructions that require draft → brief → render/attach → review-card ordering.

- [ ] **Step 1: Write failing MCP tests**

Test strict structured model/evidence input, public tool descriptions without `PMM FIELD NOTES`, package completeness rejection, and safe scheduled workflow instructions.

- [ ] **Step 2: Run MCP tests and confirm RED**

Run: `npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts`

Expected: FAIL because schemas and instructions do not support the package.

- [ ] **Step 3: Implement MCP schemas and handlers**

Pass structured content into the brief service; allow a concise daily brief and expected image count on the review launcher; reject mismatched media count before returning the widget.

- [ ] **Step 4: Run MCP tests and confirm GREEN**

Run: `npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts`

Expected: PASS.

### Task 5: Combined review package UI

**Files:**
- Modify: `src/review-card/controller.ts`
- Modify: `src/review-card/resource.ts`
- Modify: `src/review-card/client.ts`
- Test: `tests/review-card/controller.test.ts`
- Test: `tests/review-card/resource.test.ts`
- Test: `tests/http/review-card-client.test.ts`

**Interfaces:**
- Consumes: optional `dailyBrief` from the initial tool result.
- Produces: review UI order Daily Brief → LinkedIn draft → images → provenance → controls.

- [ ] **Step 1: Write failing UI/controller tests**

Assert strict parsing of the daily brief, semantic daily-brief elements, no series row, and DOM ordering with review actions last.

- [ ] **Step 2: Run review tests and confirm RED**

Run: `npx vitest run tests/review-card/controller.test.ts tests/review-card/resource.test.ts tests/http/review-card-client.test.ts`

Expected: FAIL because the card has no daily brief and still displays the series.

- [ ] **Step 3: Implement the combined review package**

Add the daily brief to `ReviewCardView`, render its sections safely using `textContent`, place images after the exact draft, hide legacy series provenance, and leave preview/publish logic unchanged.

- [ ] **Step 4: Run review tests and confirm GREEN**

Run: `npx vitest run tests/review-card/controller.test.ts tests/review-card/resource.test.ts tests/http/review-card-client.test.ts`

Expected: PASS.

### Task 6: Documentation and production verification

**Files:**
- Modify: `docs/deployment/supabase-railway-chatgpt.md`
- Modify: `README.md`

**Interfaces:**
- Produces: exact scheduled-task tool order and production smoke prompts.

- [ ] **Step 1: Document the scheduled package workflow**

Document that a scheduled run must create the draft, create the structured brief, render/attach the image, and open the combined review package last, without previewing or publishing.

- [ ] **Step 2: Run targeted verification**

Run:

```bash
npx vitest run tests/brand tests/review-card tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/db/schema-hardening.test.ts
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: all non-socket tests pass; any sandbox-only `listen()` failures are documented separately and rechecked outside the restricted runner.

- [ ] **Step 4: Apply the production migration**

Apply the Supabase migration to project `jcurllwupihgkmcrydms` without printing database secrets.

- [ ] **Step 5: Commit and push**

Commit the reviewed changes on `codex/supabase-migration` and push to `github.com/Pratikn07/pmm-career-mcp`.

- [ ] **Step 6: Deploy and smoke test**

Deploy the pushed branch to Railway, verify health/MCP discovery, and run a private Editorial Model package smoke test with no LinkedIn preview or publish.
