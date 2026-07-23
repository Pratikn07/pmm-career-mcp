# PMM Brand Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready, versioned PMM Brand Studio that creates one consistent editorial LinkedIn cover for Bhagyashree Nandoskar and hands the final private image to the existing human-approved publishing flow.

**Architecture:** ChatGPT remains the creative reasoner: it writes the post, proposes the short curiosity hook, and optionally generates text-free metaphor artwork. PMM Career MCP owns the immutable brand profile, validates and saves a visual brief, deterministically renders the final 1080×1350 PNG with bundled fonts, stores source and final media privately in Supabase, and attaches the final cover to a new draft version. Existing app-only exact preview and publish tools remain the only path to LinkedIn.

**Tech Stack:** Node.js 22, TypeScript, Zod, Drizzle ORM/PostgreSQL, Supabase private Storage, Sharp 0.35.3, `@resvg/resvg-js` 2.6.2, MCP SDK 1.29, Vitest/PGlite, Docker, Railway.

## Global Constraints

- Work on `codex/supabase-migration`; do not merge or deploy `main`.
- The production Supabase project remains `jcurllwupihgkmcrydms`; never expose its database password, service-role key, secrets, signed URLs, or user JWT.
- Do not add a service-role key. Storage access continues to use the request-scoped Supabase user JWT and the private `linkedin-draft-media` bucket.
- A scheduled or model-driven run may create a brief, render a private image, and attach it to a private draft, but may never create an exact preview, upload to LinkedIn, or publish.
- `create_exact_linkedin_preview` and `publish_exact_linkedin_post` remain app-only and widget-accessible.
- The initial brand is `PMM FIELD NOTES`, `BHAGYASHREE NANDOSKAR`, `PRODUCT MARKETING`, and monogram `BN`.
- Version one renders exactly one 1080×1350 PNG per branded post; generic existing tools still support zero to four images.
- The palette is ivory `#F6F1E8`, navy `#14233A`, copper `#B97850`, taupe `#C9B8A5`, and highlight `#FFFDF9`.
- The headline uses Cormorant Garamond Semibold/Semibold Italic; labels use Inter Medium/Semibold. Font files and licenses are committed and loaded explicitly; no runtime font download or system-font dependency.
- Hooks are 2–8 words, at most 72 Unicode characters, single-line input, and cannot repeat the opening line or a full sentence from the post.
- Source artwork contains no text, names, logos, numbers, UI, watermarks, charts, lists, or complete explanation of the post.
- Every database write is owner-scoped and versioned; cross-owner access returns `NOT_FOUND`.
- Every code task follows test-first development and ends with a focused commit.
- Do not make a live LinkedIn post during verification.

## File Structure

### New production files

- `src/brand/profile.ts` — immutable default profile, public types, and model-safe projection.
- `src/brand/hook.ts` — hook/topic normalization and deterministic validation.
- `src/brand/templates.ts` — immutable statement/metaphor template registry.
- `src/brand/prompt.ts` — canonical text-free source-art prompt construction.
- `src/brand/brief-service.ts` — owner-scoped effective profile and brief creation.
- `src/brand/assets.ts` — safe absolute resolution of bundled font assets.
- `src/brand/renderer.ts` — SVG construction, explicit-font rendering, and final PNG composition.
- `src/brand/render-service.ts` — source ingestion, rendering, persistence, cleanup, and immutable draft attachment.
- `src/media/private-media-store.ts` — reusable bounded private-media ingestion and storage.
- `assets/fonts/CormorantGaramond-SemiBold.ttf`
- `assets/fonts/CormorantGaramond-SemiBoldItalic.ttf`
- `assets/fonts/Inter-Medium.ttf`
- `assets/fonts/Inter-SemiBold.ttf`
- `assets/fonts/OFL-Cormorant.txt`
- `assets/fonts/LICENSE-Inter.txt`

### New tests

- `tests/brand/hook.test.ts`
- `tests/brand/prompt.test.ts`
- `tests/brand/brief-service.test.ts`
- `tests/brand/renderer.test.ts`
- `tests/brand/render-service.test.ts`
- `tests/media/private-media-store.test.ts`
- `tests/e2e/brand-studio-flow.test.ts`

### Existing files modified

- `src/db/schema.ts` — three normalized Brand Studio tables and constraints.
- `src/db/repositories.ts` — owner-scoped profile, brief, render, and atomic-attachment repositories.
- `src/domain/errors.ts` — safe `BRAND_NOT_CONFIGURED`/brand validation codes if the existing union requires them.
- `src/mcp/schemas.ts` — three tool contracts and Brand Studio output types.
- `src/mcp/server.ts` — model-visible Brand Studio tools and strengthened schedule instructions.
- `src/index.ts` — request-scoped Brand Studio composition.
- `src/media/post-media-service.ts` — reuse the extracted private-media store without changing existing behavior.
- `src/review-card/controller.ts` — optional brand provenance in the card model.
- `src/review-card/client.ts` — render the compact Brand Studio provenance section.
- `src/review-card/resource.ts` — card schema/resource version update if required by the controller model.
- `tests/support/database.ts` — truncate the three new tables in dependency order.
- `tests/db/repositories.test.ts` — migration/table/repository coverage.
- `tests/db/schema-hardening.test.ts` — exact-version foreign keys, indexes, and checks.
- `tests/mcp/tools.test.ts` — Brand Studio schemas, annotations, file metadata, and safe summaries.
- `tests/mcp/annotations.test.ts` — read/write/open-world classification.
- `tests/review-card/controller.test.ts`
- `tests/review-card/resource.test.ts`
- `tests/runtime/async-composition.test.ts`
- `tests/build/dockerfile.test.ts`
- `Dockerfile` — ship `assets/fonts` in build and runtime images.
- `package.json` and `package-lock.json` — pin `@resvg/resvg-js` 2.6.2.
- `README.md` — branded morning workflow and fallback behavior.
- `docs/deployment/supabase-railway-chatgpt.md` — migration, production smoke, and connector refresh.
- `drizzle/0004_pmm_brand_studio.sql` and matching `drizzle/meta/*` — generated schema migration.

---

### Task 1: Add the normalized Brand Studio schema

**Files:**
- Modify: `tests/db/repositories.test.ts`
- Modify: `tests/db/schema-hardening.test.ts`
- Modify: `tests/support/database.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0004_pmm_brand_studio.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: the Drizzle-generated next snapshot in `drizzle/meta/`

**Interfaces:**
- Produces tables `brand_profiles`, `brand_visual_briefs`, and `brand_visual_renders`.
- Produces exact composite keys consumed by repository Task 2.
- Preserves private `career_mcp` schema and existing runtime-role default grants.

- [ ] **Step 1: Write failing migration-shape tests**

Update the table inventory assertion to include the three alphabetically placed tables:

```ts
expect(tables.map((row) => row.table_name)).toEqual([
  "brand_profiles",
  "brand_visual_briefs",
  "brand_visual_renders",
  "companies",
  // existing table names unchanged
]);
```

Add exact-key assertions:

```ts
expect(constraints).toEqual(expect.arrayContaining([
  {
    constraint_name: "brand_visual_briefs_post_version_fk",
    constraint_type: "FOREIGN KEY",
    columns: "post_draft_id,post_version"
  },
  {
    constraint_name: "brand_visual_briefs_profile_version_fk",
    constraint_type: "FOREIGN KEY",
    columns: "brand_profile_id,brand_profile_version"
  }
]));
```

Add the new tables before `post_media` in `resetForTests()`:

```sql
career_mcp.brand_visual_renders,
career_mcp.brand_visual_briefs,
career_mcp.brand_profiles,
```

- [ ] **Step 2: Run the database tests and verify they fail**

Run:

```bash
npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts
```

Expected: FAIL because the three Brand Studio tables and constraints do not exist.

- [ ] **Step 3: Add the Drizzle table definitions**

Add these exported tables to `src/db/schema.ts`, preserving the project's `timestamptz` helper:

```ts
export const brandProfiles = careerMcp.table("brand_profiles", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull(),
  publicName: text("public_name").notNull(),
  roleLine: text("role_line").notNull(),
  seriesName: text("series_name").notNull(),
  monogram: text("monogram").notNull(),
  voiceJson: jsonb("voice_json").$type<Record<string, unknown>>().notNull(),
  paletteJson: jsonb("palette_json").$type<Record<string, string>>().notNull(),
  hookRulesJson: jsonb("hook_rules_json").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  unique("brand_profiles_row_version_unique").on(table.id, table.version),
  unique("brand_profiles_owner_version_unique").on(table.ownerSubject, table.version),
  uniqueIndex("brand_profiles_one_active_owner_unique")
    .on(table.ownerSubject)
    .where(sql`${table.state} = 'active'`),
  check("brand_profiles_version_check", sql`${table.version} >= 1`),
  check("brand_profiles_state_check", sql`${table.state} in ('active','retired')`)
]);

export const brandVisualBriefs = careerMcp.table("brand_visual_briefs", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  postDraftId: uuid("post_draft_id").notNull(),
  postVersion: integer("post_version").notNull(),
  brandProfileId: uuid("brand_profile_id").notNull(),
  brandProfileVersion: integer("brand_profile_version").notNull(),
  templateId: text("template_id").notNull(),
  templateVersion: integer("template_version").notNull(),
  promptFormatVersion: integer("prompt_format_version").notNull(),
  visualMode: text("visual_mode").notNull(),
  coverHook: text("cover_hook").notNull(),
  conceptSummary: text("concept_summary").notNull(),
  topicLabel: text("topic_label"),
  generationPrompt: text("generation_prompt").notNull(),
  negativeConstraintsJson: jsonb("negative_constraints_json").$type<string[]>().notNull(),
  state: text("state").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  foreignKey({
    name: "brand_visual_briefs_post_version_fk",
    columns: [table.postDraftId, table.postVersion],
    foreignColumns: [postDrafts.id, postDrafts.version]
  }),
  foreignKey({
    name: "brand_visual_briefs_profile_version_fk",
    columns: [table.brandProfileId, table.brandProfileVersion],
    foreignColumns: [brandProfiles.id, brandProfiles.version]
  }),
  index("brand_visual_briefs_post_version_idx").on(table.postDraftId, table.postVersion),
  index("brand_visual_briefs_profile_version_idx")
    .on(table.brandProfileId, table.brandProfileVersion),
  index("brand_visual_briefs_owner_created_idx").on(table.ownerSubject, table.createdAt),
  check("brand_visual_briefs_mode_check",
    sql`${table.visualMode} in ('EDITORIAL_STATEMENT','EDITORIAL_METAPHOR')`),
  check("brand_visual_briefs_state_check", sql`${table.state} in ('ready','rendered')`)
]);

export const brandVisualRenders = careerMcp.table("brand_visual_renders", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  briefId: uuid("brief_id").notNull().references(() => brandVisualBriefs.id),
  version: integer("version").notNull(),
  sourceMediaId: uuid("source_media_id").references(() => postMedia.id),
  renderedMediaId: uuid("rendered_media_id").notNull().references(() => postMedia.id),
  altText: text("alt_text").notNull(),
  renderChecksum: text("render_checksum").notNull(),
  rendererVersion: integer("renderer_version").notNull(),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  unique("brand_visual_renders_brief_version_unique").on(table.briefId, table.version),
  index("brand_visual_renders_brief_id_idx").on(table.briefId),
  index("brand_visual_renders_source_media_id_idx").on(table.sourceMediaId),
  index("brand_visual_renders_rendered_media_id_idx").on(table.renderedMediaId),
  check("brand_visual_renders_version_check", sql`${table.version} >= 1`),
  check("brand_visual_renders_renderer_version_check", sql`${table.rendererVersion} >= 1`),
  check("brand_visual_renders_checksum_check",
    sql`${table.renderChecksum} ~ '^[0-9a-f]{64}$'`),
  check("brand_visual_renders_alt_text_check",
    sql`char_length(${table.altText}) between 1 and 120`)
]);
```

Add all three exports to the final `schema` object.

Place `brandProfiles` before `postMedia`, place `brandVisualBriefs` immediately
after `postDrafts`, and place `brandVisualRenders` after
`brandVisualBriefs`. This keeps every Drizzle foreign-key callback bound to an
already declared table.

- [ ] **Step 4: Generate and inspect the migration**

Run:

```bash
npx drizzle-kit generate --name pmm_brand_studio
```

Expected: creates `drizzle/0004_pmm_brand_studio.sql`, updates the journal, and writes the next schema snapshot. Inspect the SQL and verify it never references `storage.objects`, `storage.buckets`, `anon`, `authenticated`, RLS disabling, or a service role.

- [ ] **Step 5: Run schema tests**

Run:

```bash
npx vitest run tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle tests/db tests/support/database.ts
git commit -m "feat: add PMM brand studio schema"
```

---

### Task 2: Add owner-scoped Brand Studio repositories

**Files:**
- Modify: `src/db/repositories.ts`
- Modify: `tests/db/repositories.test.ts`

**Interfaces:**
- Produces `database.brandProfiles.getActive(ownerSubject)`.
- Produces `database.brandProfiles.ensureDefault(input)`.
- Produces `database.brandVisualBriefs.create(input)`, `getOwned(id, ownerSubject)`, and `listRecent(ownerSubject, limit)`.
- Produces `database.brandVisualRenders.getByRenderedMedia(ownerSubject, mediaId)`.
- Task 5 later adds the atomic render-and-attach write to this repository.

- [ ] **Step 1: Write failing owner and version tests**

Add tests that:

```ts
const owner = randomUUID();
const profile = await db.brandProfiles.ensureDefault({
  ownerSubject: owner,
  id: randomUUID(),
  publicName: "Bhagyashree Nandoskar",
  roleLine: "Product Marketing",
  seriesName: "PMM FIELD NOTES",
  monogram: "BN",
  voiceJson: { persona: "curious PMM practitioner" },
  paletteJson: { ivory: "#F6F1E8" },
  hookRulesJson: { minWords: 2, maxWords: 8 }
});

expect((await db.brandProfiles.getActive(owner))?.id).toBe(profile.id);
expect((await db.brandProfiles.getActive(randomUUID()))).toBeUndefined();
```

Create a post, create one brief, and verify `getOwned` returns it only for the matching owner and `listRecent(owner, 10)` is newest-first and bounded.

- [ ] **Step 2: Run the repository test and verify it fails**

Run:

```bash
npx vitest run tests/db/repositories.test.ts -t "Brand Studio repositories"
```

Expected: FAIL because the repositories do not exist.

- [ ] **Step 3: Add repository types and methods**

Import the three tables and export inferred row types:

```ts
export type BrandProfile = typeof brandProfiles.$inferSelect;
export type BrandVisualBrief = typeof brandVisualBriefs.$inferSelect;
export type BrandVisualRender = typeof brandVisualRenders.$inferSelect;
```

Implement owner normalization using the existing UUID validation and
`normalizeRowTimestamps`. `ensureDefault` must run in a serializable
transaction, return an existing active row if one exists, and insert version 1
only when none exists. Retry only
`brand_profiles_one_active_owner_unique`.

The public method shapes are:

```ts
brandProfiles: {
  getActive(ownerSubject: string): Promise<BrandProfile | undefined>;
  ensureDefault(input: {
    id: string;
    ownerSubject: string;
    publicName: string;
    roleLine: string;
    seriesName: string;
    monogram: string;
    voiceJson: Record<string, unknown>;
    paletteJson: Record<string, string>;
    hookRulesJson: Record<string, unknown>;
  }): Promise<BrandProfile>;
};

brandVisualBriefs: {
  create(input: Omit<typeof brandVisualBriefs.$inferInsert, "createdAt">):
    Promise<BrandVisualBrief>;
  getOwned(id: string, ownerSubject: string):
    Promise<BrandVisualBrief | undefined>;
  listRecent(ownerSubject: string, limit: number):
    Promise<BrandVisualBrief[]>;
};

brandVisualRenders: {
  getByRenderedMedia(ownerSubject: string, mediaId: string):
    Promise<(BrandVisualRender & { brief: BrandVisualBrief; profile: BrandProfile }) | undefined>;
};
```

Clamp `listRecent` to `1..50`. Invalid UUID inputs return `undefined` or `[]`,
matching existing repository behavior.

- [ ] **Step 4: Run repository tests**

Run:

```bash
npx vitest run tests/db/repositories.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts tests/db/repositories.test.ts
git commit -m "feat: add brand studio repositories"
```

---

### Task 3: Implement the immutable profile, hook rules, templates, and prompt

**Files:**
- Create: `src/brand/profile.ts`
- Create: `src/brand/hook.ts`
- Create: `src/brand/templates.ts`
- Create: `src/brand/prompt.ts`
- Create: `tests/brand/hook.test.ts`
- Create: `tests/brand/prompt.test.ts`

**Interfaces:**
- Produces `DEFAULT_PMM_BRAND_PROFILE`.
- Produces `validateCoverHook(postText, rawHook)` and `normalizeTopicLabel`.
- Produces `templateForMode(mode)`.
- Produces `buildSourceArtPrompt(profile, template, conceptSummary)`.

- [ ] **Step 1: Write failing hook tests**

Cover these exact behaviors:

```ts
expect(validateCoverHook(
  "Teams often mistake more features for more value.",
  "Clarity beats capability."
)).toBe("Clarity beats capability.");

expect(() => validateCoverHook("Clarity beats capability.", "Clarity beats capability."))
  .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

expect(() => validateCoverHook("Post", "One two three four five six seven eight nine"))
  .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

expect(() => validateCoverHook("Post", "Read this now"))
  .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

expect(normalizeTopicLabel(" Positioning ")).toBe("POSITIONING");
```

- [ ] **Step 2: Run the hook test and verify it fails**

Run:

```bash
npx vitest run tests/brand/hook.test.ts
```

Expected: FAIL because the brand modules do not exist.

- [ ] **Step 3: Implement the default profile and templates**

Use readonly domain types:

```ts
export type BrandVisualMode = "EDITORIAL_STATEMENT" | "EDITORIAL_METAPHOR";

export type PmmBrandProfile = Readonly<{
  version: 1;
  publicName: string;
  roleLine: string;
  seriesName: string;
  monogram: string;
  voice: Readonly<{
    persona: string;
    traits: readonly string[];
    neverInventExperience: true;
  }>;
  palette: Readonly<{
    ivory: string;
    navy: string;
    copper: string;
    taupe: string;
    highlight: string;
  }>;
  hookRules: Readonly<{
    minWords: 2;
    maxWords: 8;
    maxCharacters: 72;
    recentWindow: 30;
  }>;
}>;

export type ModelSafeBrandProfile = PmmBrandProfile & Readonly<{
  recentUsage: readonly Readonly<{
    templateId: string;
    coverHook: string;
    createdAt: string;
  }>[];
}>;

export const DEFAULT_PMM_BRAND_PROFILE: PmmBrandProfile = Object.freeze({
  version: 1,
  publicName: "Bhagyashree Nandoskar",
  roleLine: "Product Marketing",
  seriesName: "PMM FIELD NOTES",
  monogram: "BN",
  voice: {
    persona: "curious PMM practitioner",
    traits: ["thoughtful", "practical", "observant", "conversational", "evidence-aware"],
    neverInventExperience: true
  },
  palette: {
    ivory: "#F6F1E8",
    navy: "#14233A",
    copper: "#B97850",
    taupe: "#C9B8A5",
    highlight: "#FFFDF9"
  },
  hookRules: {
    minWords: 2,
    maxWords: 8,
    maxCharacters: 72,
    recentWindow: 30
  }
} as const);
```

`templates.ts` exports immutable statement and metaphor definitions with
`id`, `version`, `width: 1080`, `height: 1350`, safe text rectangles, image
zone, and `requiresSourceImage`.

- [ ] **Step 4: Implement deterministic hook validation**

Normalize with NFC and collapsed whitespace. Split post sentences on
`.`, `!`, `?`, and Unicode line separators after normalization. Reject:

```ts
const BAIT = [
  "you won't believe",
  "read this",
  "here's the secret"
] as const;
```

Also reject URLs, `#hashtags`, leading bullet characters, more than two emoji
code points, and digit-containing claims. Return a safe `DomainError` with
`field: "coverHook"` and a non-secret reason code.

- [ ] **Step 5: Write and run failing prompt tests**

Assert that the prompt contains the palette and concept but excludes the hook
and personal name:

```ts
const prompt = buildSourceArtPrompt(
  DEFAULT_PMM_BRAND_PROFILE,
  templateForMode("EDITORIAL_METAPHOR"),
  "An open doorway whose destination is intentionally ambiguous"
);

expect(prompt.generationPrompt).toContain("warm ivory");
expect(prompt.generationPrompt).toContain("open doorway");
expect(prompt.generationPrompt).not.toContain("Bhagyashree");
expect(prompt.negativeConstraints).toContain("readable text");
```

Run:

```bash
npx vitest run tests/brand/prompt.test.ts
```

Expected: FAIL before `prompt.ts` is implemented.

- [ ] **Step 6: Implement canonical prompt construction**

Export:

```ts
export type SourceArtPrompt = Readonly<{
  formatVersion: 1;
  generationPrompt: string;
  negativeConstraints: readonly string[];
}>;

export function buildSourceArtPrompt(
  profile: PmmBrandProfile,
  template: BrandTemplate,
  conceptSummary: string
): SourceArtPrompt;
```

Bound `conceptSummary` to 1–500 Unicode characters, remove line-control
characters, and append the exact no-text/no-logo/no-infographic constraints
from the approved design.

- [ ] **Step 7: Run brand-domain tests**

Run:

```bash
npx vitest run tests/brand/hook.test.ts tests/brand/prompt.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/brand tests/brand
git commit -m "feat: define PMM brand profile and visual rules"
```

---

### Task 4: Create and persist versioned visual briefs

**Files:**
- Create: `src/brand/brief-service.ts`
- Create: `tests/brand/brief-service.test.ts`
- Modify: `src/domain/errors.ts` only if the existing error-code type is closed.

**Interfaces:**
- Consumes Task 2 repositories and Task 3 domain functions.
- Produces `createBrandBriefService(database, { subject, createId? })`.
- Produces `BrandBriefService.getProfile()`, `createBrief(input)`, and
  `getProvenanceForMedia(mediaId)`.

- [ ] **Step 1: Write failing service tests**

Test effective read-only default, first-write initialization, stale version,
owner isolation, recent exact hook rejection, statement prompt behavior, and
metaphor prompt behavior:

```ts
const service = createBrandBriefService(db, {
  subject: owner,
  createId: () => briefId
});

expect((await service.getProfile()).seriesName).toBe("PMM FIELD NOTES");

const result = await service.createBrief({
  postId: post.draftId,
  expectedVersion: post.version,
  coverHook: "Clarity beats capability.",
  conceptSummary: "Restrained editorial geometry about choosing clarity",
  visualMode: "EDITORIAL_STATEMENT",
  topicLabel: "Positioning"
});

expect(result.brief.ownerSubject).toBe(owner);
expect(result.requiresSourceImage).toBe(false);
expect(result.profile.version).toBe(1);
```

- [ ] **Step 2: Run the service test and verify it fails**

Run:

```bash
npx vitest run tests/brand/brief-service.test.ts
```

Expected: FAIL because `brief-service.ts` does not exist.

- [ ] **Step 3: Implement the service**

The service interface is:

```ts
export type CreateBrandVisualBriefInput = Readonly<{
  postId: string;
  expectedVersion: number;
  coverHook: string;
  conceptSummary: string;
  visualMode: BrandVisualMode;
  topicLabel?: string;
}>;

export type BrandBriefService = Readonly<{
  getProfile(): Promise<ModelSafeBrandProfile>;
  createBrief(input: CreateBrandVisualBriefInput): Promise<{
    brief: BrandVisualBrief;
    profile: ModelSafeBrandProfile;
    requiresSourceImage: boolean;
    proposedAltText: string;
  }>;
  getProvenanceForMedia(mediaId: string): Promise<BrandReviewProvenance | undefined>;
}>;

export type BrandReviewProvenance = Readonly<{
  seriesName: string;
  profileVersion: number;
  templateId: string;
  templateVersion: number;
  coverHook: string;
  renderChecksum: string;
  validationPassed: boolean;
}>;

export function createBrandBriefService(
  database: CareerDatabase,
  dependencies: {
    subject: string;
    createId?: () => string;
  }
): BrandBriefService;
```

`getProfile` returns the immutable code default without writing when no active
row exists. `createBrief` loads the exact draft, verifies it is the latest
version, ensures the owner-scoped version-one profile, validates the hook,
checks the last 30 exact hooks, constructs the prompt, and saves the brief.
The proposed alt text is bounded and factual, for example
`Editorial PMM Field Notes cover reading “${coverHook}”.`.
`getProvenanceForMedia` delegates to the owner-scoped render repository and
returns only the series name, profile/template versions, hook, render checksum,
and validation status required by the review card.

- [ ] **Step 4: Run brief-service tests**

Run:

```bash
npx vitest run tests/brand/brief-service.test.ts tests/db/repositories.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brand/brief-service.ts src/domain/errors.ts tests/brand/brief-service.test.ts
git commit -m "feat: save versioned brand visual briefs"
```

---

### Task 5: Add explicit-font deterministic cover rendering

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `assets/fonts/*`
- Create: `src/brand/assets.ts`
- Create: `src/brand/renderer.ts`
- Create: `tests/brand/renderer.test.ts`
- Modify: `Dockerfile`
- Modify: `tests/build/dockerfile.test.ts`

**Interfaces:**
- Consumes Task 3 templates and profile.
- Produces `renderBrandedCover(input): Promise<RenderedBrandCover>`.
- Produces deterministic SVG via `buildCoverSvg(input)`.

- [ ] **Step 1: Write failing renderer and Docker tests**

Tests must assert:

```ts
const result = await renderBrandedCover({
  profile: DEFAULT_PMM_BRAND_PROFILE,
  template: templateForMode("EDITORIAL_STATEMENT"),
  coverHook: "Clarity beats capability.",
  topicLabel: "POSITIONING",
  sourceImageBytes: undefined
});

expect(result.mimeType).toBe("image/png");
expect(result.width).toBe(1080);
expect(result.height).toBe(1350);
expect(result.bytes.subarray(1, 4).toString()).toBe("PNG");
expect(result.validation).toEqual({
  fixedLabelsPresent: true,
  textWithinSafeArea: true,
  sourceImageUsed: false
});
```

Test that `buildCoverSvg` XML-escapes `<`, `>`, `&`, quotes, and never inserts
caller-provided SVG. Update the Docker test to require `COPY assets ./assets`
in both build and runtime stages.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run tests/brand/renderer.test.ts tests/build/dockerfile.test.ts
```

Expected: FAIL because renderer, fonts, dependency, and Docker copies are absent.

- [ ] **Step 3: Pin the SVG renderer**

Run:

```bash
npm install --save-exact @resvg/resvg-js@2.6.2
```

Expected: `package.json` and lockfile contain exact version `2.6.2`.

- [ ] **Step 4: Acquire and license the exact font assets**

Use the pinned upstream sources:

```bash
mkdir -p assets/fonts
curl -L --fail --silent --show-error \
  -o assets/fonts/CormorantGaramond-SemiBold.ttf \
  https://raw.githubusercontent.com/CatharsisFonts/Cormorant/9719e26aa8e26d7a30e736667427b9e05b5db059/fonts/ttf/CormorantGaramond-SemiBold.ttf
curl -L --fail --silent --show-error \
  -o assets/fonts/CormorantGaramond-SemiBoldItalic.ttf \
  https://raw.githubusercontent.com/CatharsisFonts/Cormorant/9719e26aa8e26d7a30e736667427b9e05b5db059/fonts/ttf/CormorantGaramond-SemiBoldItalic.ttf
curl -L --fail --silent --show-error \
  -o assets/fonts/OFL-Cormorant.txt \
  https://raw.githubusercontent.com/CatharsisFonts/Cormorant/9719e26aa8e26d7a30e736667427b9e05b5db059/OFL.txt
```

Download Inter 4.1 from the official release, extract only the two TTFs and
license, and verify SHA-256 values before committing:

```bash
task_font_dir=$(mktemp -d)
curl -L --fail --silent --show-error \
  -o "$task_font_dir/Inter-4.1.zip" \
  https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
unzip -j "$task_font_dir/Inter-4.1.zip" \
  extras/ttf/Inter-Medium.ttf \
  extras/ttf/Inter-SemiBold.ttf \
  LICENSE.txt \
  -d "$task_font_dir/extracted"
cp "$task_font_dir/extracted/Inter-Medium.ttf" assets/fonts/Inter-Medium.ttf
cp "$task_font_dir/extracted/Inter-SemiBold.ttf" assets/fonts/Inter-SemiBold.ttf
cp "$task_font_dir/extracted/LICENSE.txt" assets/fonts/LICENSE-Inter.txt
shasum -a 256 assets/fonts/*
```

Assert these exact SHA-256 values in `tests/brand/renderer.test.ts` so altered
font binaries or licenses fail verification:

```text
dc4bc094dc3c55cf79ff2f6f0ba1e501b712fc3cf3742296cd8fdcc6e995127d  CormorantGaramond-SemiBold.ttf
d9b23c3f2109428aa293cc9bfdba2a9d1c96392a1182227a40c7a24967b1211c  CormorantGaramond-SemiBoldItalic.ttf
97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872  Inter-Medium.ttf
78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3  Inter-SemiBold.ttf
60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956  OFL-Cormorant.txt
262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a  LICENSE-Inter.txt
```

- [ ] **Step 5: Implement asset resolution and rendering**

`assets.ts` walks upward from `import.meta.url` until it finds both
`package.json` and `assets/fonts`, mirroring the migration-folder pattern.

`renderer.ts` uses:

```ts
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1080 },
  font: {
    fontFiles: [
      fontPath("CormorantGaramond-SemiBold.ttf"),
      fontPath("CormorantGaramond-SemiBoldItalic.ttf"),
      fontPath("Inter-Medium.ttf"),
      fontPath("Inter-SemiBold.ttf")
    ],
    loadSystemFonts: false,
    defaultFontFamily: "Inter"
  }
});
const typographyPng = Buffer.from(resvg.render().asPng());
```

Use Sharp to create the ivory base, deterministic subtle texture, template
geometry, optional source-image composite, then typography composite. Export:

```ts
export type RenderedBrandCover = Readonly<{
  bytes: Buffer;
  mimeType: "image/png";
  width: 1080;
  height: 1350;
  validation: {
    fixedLabelsPresent: true;
    textWithinSafeArea: true;
    sourceImageUsed: boolean;
  };
}>;

export type RenderBrandedCoverInput = Readonly<{
  profile: PmmBrandProfile;
  template: BrandTemplate;
  coverHook: string;
  topicLabel?: string;
  sourceImageBytes?: Buffer;
}>;
```

The SVG contains only XML-escaped normalized strings. Implement the fixed
2–4, 5–6, and 7–8 word layout table from the design; reject hooks that cannot
fit two lines.

- [ ] **Step 6: Ship fonts in Docker and run tests**

Add `COPY assets ./assets` to both Docker stages. Run:

```bash
npx vitest run tests/brand/renderer.test.ts tests/build/dockerfile.test.ts
npm run build
```

Expected: PASS and build succeeds.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json assets src/brand/assets.ts src/brand/renderer.ts tests/brand/renderer.test.ts Dockerfile tests/build/dockerfile.test.ts
git commit -m "feat: render deterministic PMM editorial covers"
```

---

### Task 6: Extract reusable private-media ingestion

**Files:**
- Create: `src/media/private-media-store.ts`
- Create: `tests/media/private-media-store.test.ts`
- Modify: `src/media/post-media-service.ts`
- Modify: `tests/media/post-media-service.test.ts`

**Interfaces:**
- Produces `createPrivateMediaStore(database, dependencies)`.
- Produces `ingestOpenAiFile`, `storeBytes`, and `removeBestEffort`.
- Keeps every existing `createPostMediaService` public method and behavior unchanged.

- [ ] **Step 1: Write failing private-store tests**

Test source-file ingestion, byte ingestion, owner dedupe, safe object paths,
and cleanup:

```ts
const store = createPrivateMediaStore(db, {
  subject: owner,
  storage,
  downloadFile: vi.fn().mockResolvedValue(fixturePng),
  inspectImage: inspectLinkedInImage,
  createId: () => mediaId
});

const stored = await store.ingestOpenAiFile(openAiFile);
expect(stored.media.ownerSubject).toBe(owner);
expect(stored.media.objectPath).toMatch(
  new RegExp(`^${owner}/[0-9a-f]{2}/${mediaId}\\.png$`)
);
expect(stored.bytes.equals(fixturePng)).toBe(true);
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run tests/media/private-media-store.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the extracted store**

Move the current bounded file download, inspection, extension, upload, dedupe,
and cleanup logic behind:

```ts
export type StoredPrivateMedia = Readonly<{
  media: PostMedia;
  bytes: Buffer;
  createdObjectPath?: string;
}>;

export type PrivateMediaStoreDependencies = Readonly<{
  subject: string;
  storage: DraftMediaStorage;
  downloadFile?: typeof downloadOpenAiFile;
  inspectImage?: typeof inspectLinkedInImage;
  createId?: () => string;
}>;

export function createPrivateMediaStore(
  database: CareerDatabase,
  dependencies: PrivateMediaStoreDependencies
) {
  return {
    ingestOpenAiFile(file: OpenAiFileRef): Promise<StoredPrivateMedia>,
    storeBytes(bytes: Buffer, originalFilename: string): Promise<StoredPrivateMedia>,
    removeBestEffort(items: readonly StoredPrivateMedia[]): Promise<void>
  };
}
```

`storeBytes` always runs `inspectLinkedInImage` on the supplied bytes and uses
the inspected MIME type, dimensions, frame count, and SHA-256. It never trusts
the filename.

- [ ] **Step 4: Refactor existing image attachment to use the store**

`createPostMediaService` creates one private store and delegates ingestion and
cleanup. Do not change tool-visible results, checksum behavior, or immutable
version semantics.

- [ ] **Step 5: Run media regression tests**

Run:

```bash
npx vitest run tests/media/private-media-store.test.ts tests/media/post-media-service.test.ts tests/e2e/linkedin-image-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/media tests/media tests/e2e/linkedin-image-flow.test.ts
git commit -m "refactor: share bounded private media ingestion"
```

---

### Task 7: Render, persist, and atomically attach the final branded cover

**Files:**
- Modify: `src/db/repositories.ts`
- Create: `src/brand/render-service.ts`
- Create: `tests/brand/render-service.test.ts`
- Modify: `tests/db/repositories.test.ts`

**Interfaces:**
- Consumes Task 4 briefs, Task 5 renderer, and Task 6 media store.
- Produces `database.brandVisualRenders.commitAndAttach(input)`.
- Produces `createBrandRenderService(database, dependencies).render(input)`.

- [ ] **Step 1: Write failing atomic repository and service tests**

Cover:

- statement mode rejects a supplied source image;
- metaphor mode requires one source image;
- stale post version returns `CONFLICT`;
- wrong-owner brief returns `NOT_FOUND`;
- statement render creates exactly one final `post_draft_media` row;
- source media remains private and unattached;
- render row references the source and final media correctly;
- storage/database failure removes newly created unreferenced objects;
- no preview or publish row is created.

Use this call shape:

```ts
const result = await service.render({
  briefId,
  postId: post.draftId,
  expectedVersion: post.version,
  altText: "PMM Field Notes cover reading “Clarity beats capability.”"
});

expect(result.post.version).toBe(post.version + 1);
expect(result.post.media).toHaveLength(1);
expect(result.provenance.templateId).toBe("editorial-statement-v1");
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run tests/brand/render-service.test.ts tests/db/repositories.test.ts -t "branded render"
```

Expected: FAIL because the service and atomic repository method do not exist.

- [ ] **Step 3: Implement the atomic repository write**

Add:

```ts
brandVisualRenders.commitAndAttach(input: {
  ownerSubject: string;
  briefId: string;
  expectedDraftId: string;
  expectedVersion: number;
  sourceMediaId?: string;
  renderedMediaId: string;
  altText: string;
  renderChecksum: string;
  rendererVersion: number;
  checksum: (
    nextVersion: number,
    logicalDraftId: string,
    media: readonly {
      position: number;
      sha256: string;
      mimeType: string;
      altText: string;
    }[]
  ) => string;
}): Promise<{
  post: PostDraft;
  render: BrandVisualRender;
}>;
```

Inside one serializable transaction:

1. Load the owner-scoped brief and its exact source post row.
2. Confirm the source row is still the latest logical draft version.
3. Confirm source/final media ownership and final checksum.
4. Insert the next immutable post row with the same text and visibility.
5. Insert one position-zero `post_draft_media` row for the final PNG.
6. Insert the render provenance row.
7. Update the brief from `ready` to `rendered`.

Retry only serialization/deadlock and the named post/render version
constraints.

- [ ] **Step 4: Implement `createBrandRenderService`**

Export:

```ts
export type RenderBrandCoverInput = Readonly<{
  briefId: string;
  postId: string;
  expectedVersion: number;
  sourceImage?: OpenAiFileRef;
  altText: string;
}>;
```

The service validates UUID/version/alt text, loads the owner brief, enforces
source-image mode, ingests optional source, renders the cover, stores the final
bytes as `brand-cover.png`, and calls `commitAndAttach`. It returns:

```ts
{
  post: MediaPostDraftVersion;
  provenance: {
    profileVersion: number;
    templateId: string;
    templateVersion: number;
    coverHook: string;
    renderChecksum: string;
    validation: RenderedBrandCover["validation"];
  };
}
```

On error, remove only newly created, unreferenced objects best-effort and
preserve the original safe domain error.

Export the request-scoped service contract:

```ts
export type BrandRenderService = Readonly<{
  render(input: RenderBrandCoverInput): Promise<{
    post: MediaPostDraftVersion;
    provenance: BrandReviewProvenance & {
      validation: RenderedBrandCover["validation"];
    };
  }>;
}>;

export function createBrandRenderService(
  database: CareerDatabase,
  dependencies: {
    subject: string;
    privateMedia: ReturnType<typeof createPrivateMediaStore>;
    renderCover?: typeof renderBrandedCover;
  }
): BrandRenderService;
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/brand/render-service.test.ts tests/db/repositories.test.ts tests/media/post-media-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories.ts src/brand/render-service.ts tests/brand/render-service.test.ts tests/db/repositories.test.ts
git commit -m "feat: attach immutable branded covers"
```

---

### Task 8: Expose safe Brand Studio MCP tools

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/annotations.test.ts`
- Modify: `tests/mcp/http-safety.test.ts`

**Interfaces:**
- Consumes Task 4 `BrandBriefService` and Task 7 `BrandRenderService`.
- Produces tools `get_pmm_brand_profile`, `create_branded_visual_brief`, and `render_branded_linkedin_cover`.

- [ ] **Step 1: Write failing schema and tool tests**

Add strict inputs:

```ts
export const createBrandedVisualBriefInput = z.object({
  postId: id,
  expectedVersion: z.number().int().positive(),
  coverHook: z.string().trim().min(1).max(72),
  conceptSummary: z.string().trim().min(1).max(500),
  visualMode: z.enum(["EDITORIAL_STATEMENT", "EDITORIAL_METAPHOR"]),
  topicLabel: z.string().trim().min(1).max(24).optional()
}).strict();

export const renderBrandedLinkedInCoverInput = z.object({
  briefId: id,
  postId: id,
  expectedVersion: z.number().int().positive(),
  sourceImage: openAiFileSchema.optional(),
  altText: imageAltText
}).strict();
```

Tool-list tests assert:

- profile tool is read-only and closed-world;
- brief tool is a private write and closed-world;
- render tool is a private attachment write and open-world;
- render `_meta["openai/fileParams"]` equals `["sourceImage"]`;
- exact preview and publish remain `ui.visibility: ["app"]`;
- none of the three model-visible tools mention or call LinkedIn upload.

- [ ] **Step 2: Run MCP tests and verify they fail**

Run:

```bash
npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/mcp/http-safety.test.ts
```

Expected: FAIL because the schemas, dependencies, and tools are absent.

- [ ] **Step 3: Add output schemas**

Return only model-safe values. The brief output includes canonical prompt and
negative constraints; the render output includes the new post version and
provenance. It must not include object paths, source download URLs, JWTs,
signed URLs, font paths, or approval capabilities.

- [ ] **Step 4: Register the tools**

Extend `CareerMcpDependencies`:

```ts
brand?: Pick<
  BrandBriefService,
  "getProfile" | "createBrief" | "getProvenanceForMedia"
>;
brandRenderer?: Pick<BrandRenderService, "render">;
```

Add an authenticated accessor for each. Register:

```ts
server.registerTool("get_pmm_brand_profile", {
  title: "Get PMM brand profile",
  description: "Return the active model-safe PMM Field Notes brand rules. Read-only.",
  inputSchema: emptyInputSchema,
  outputSchema: getPmmBrandProfileOutput,
  annotations: readOnly,
  _meta: oauthToolMetadata
}, async () => guarded(async () => ({
  profile: await authenticatedBrand().getProfile()
}), () => "Loaded the active PMM Field Notes brand profile; nothing was changed.")());
```

Use `privateWrite` for brief and `attachmentWrite` plus:

```ts
const brandRenderToolMetadata = {
  ...oauthToolMetadata,
  "openai/fileParams": ["sourceImage"]
};
```

Tool summaries must say:

- brief: `Saved one private branded visual brief; no image was attached, previewed, uploaded to LinkedIn, or published.`
- render: `Saved one private branded cover in post version N; nothing was previewed, uploaded to LinkedIn, or published.`

Extend `CAREER_MCP_INSTRUCTIONS` to state that branded visuals are curiosity
covers, not post summaries, and source art must contain no text.

- [ ] **Step 5: Run MCP tests**

Run:

```bash
npx vitest run tests/mcp/tools.test.ts tests/mcp/annotations.test.ts tests/mcp/http-safety.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp tests/mcp
git commit -m "feat: expose safe PMM brand studio tools"
```

---

### Task 9: Wire request-scoped services and show brand provenance in review

**Files:**
- Modify: `src/index.ts`
- Modify: `src/review-card/controller.ts`
- Modify: `src/review-card/client.ts`
- Modify: `src/review-card/resource.ts`
- Modify: `tests/runtime/async-composition.test.ts`
- Modify: `tests/review-card/controller.test.ts`
- Modify: `tests/review-card/resource.test.ts`
- Modify: `tests/http/review-card-client.test.ts`

**Interfaces:**
- Consumes all service interfaces from Tasks 4–8.
- Produces a request-scoped brand brief/render composition using the same authenticated subject and private storage.
- Produces optional review-card `brand` provenance.

- [ ] **Step 1: Write failing composition and card tests**

Verify an authenticated MCP server lists all three brand tools, while an
unauthenticated production request cannot use them. Add controller fixture:

```ts
brand: {
  seriesName: "PMM FIELD NOTES",
  profileVersion: 1,
  templateId: "editorial-statement-v1",
  templateVersion: 1,
  coverHook: "Clarity beats capability.",
  renderChecksum: "a".repeat(64),
  validationPassed: true
}
```

Assert the client renders the series, template, hook, and abbreviated checksum
without exposing source or storage data.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npx vitest run tests/runtime/async-composition.test.ts tests/review-card tests/http/review-card-client.test.ts
```

Expected: FAIL because services and card provenance are not wired.

- [ ] **Step 3: Compose services once per authenticated request**

Create the brand brief service for every authenticated request. Create the
renderer only when private media is configured:

```ts
if (context !== undefined) {
  brand = createBrandBriefService(database, { subject: context.subject });
}
if (context !== undefined && hasPrivateMediaConfiguration(options.config)) {
  const storage = mediaStorageFactory(options.config, context);
  const privateMedia = createPrivateMediaStore(database, {
    subject: context.subject,
    storage,
    ...(options.mediaDownloadFile === undefined ? {} : { downloadFile: options.mediaDownloadFile }),
    ...(options.mediaInspectImage === undefined ? {} : { inspectImage: options.mediaInspectImage })
  });
  brandRenderer = createBrandRenderService(database, {
    subject: context.subject,
    privateMedia,
    renderCover: renderBrandedCover
  });
}
```

Pass both to `createCareerMcpServer`. Ensure no network or render work occurs
until a corresponding tool is called.

- [ ] **Step 4: Add optional provenance to the review card**

When `open_linkedin_review_card` loads the post, call
`deps.brand?.getProvenanceForMedia` for the position-zero media ID. Return an
optional model-safe `brand` object in structured content. Render it below the
image/alt-text section; do not add edit, preview, or publish capability.

- [ ] **Step 5: Build the card and run tests**

Run:

```bash
npm run build:review-card
npx vitest run tests/runtime/async-composition.test.ts tests/review-card tests/http/review-card-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/review-card tests/runtime tests/review-card tests/http/review-card-client.test.ts dist/public/review-card-client.js
git commit -m "feat: show brand provenance in LinkedIn review"
```

If `dist/public/review-card-client.js` is ignored rather than tracked, omit it
from `git add`; the Docker build must generate it.

---

### Task 10: Prove the scheduled-flow boundary end to end

**Files:**
- Create: `tests/e2e/brand-studio-flow.test.ts`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `README.md`
- Modify: `docs/deployment/supabase-railway-chatgpt.md`

**Interfaces:**
- Verifies the complete private brand flow and unchanged app-only publication boundary.
- Produces the final operator prompt and production smoke instructions.

- [ ] **Step 1: Write the failing end-to-end test**

The test must:

1. authenticate as a fixture subject;
2. save a text post;
3. call `get_pmm_brand_profile`;
4. create a statement brief;
5. render without a source file;
6. verify the new post version has one 1080×1350 PNG;
7. open the non-writing review card;
8. verify zero preview rows, zero publish attempts, and zero LinkedIn client calls;
9. confirm model-visible tool discovery excludes exact preview and publish;
10. call app-only exact preview through the widget test path and verify the
    final image checksum is locked.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run tests/e2e/brand-studio-flow.test.ts
```

Expected: FAIL until the full composition is correct.

- [ ] **Step 3: Complete only the missing integration fixes**

Keep fixes inside the interfaces already defined in Tasks 1–9. Do not add
background jobs, automatic preview, automatic publishing, a server-side image
API, or another storage credential.

- [ ] **Step 4: Update operator documentation**

Add the daily schedule prompt:

```text
Research today's approved PMM topic and save a private LinkedIn draft in PMM
Career MCP. Use the active PMM FIELD NOTES brand profile. Create a short,
curiosity-driven cover hook that does not explain the post. Save a branded
visual brief and render one private editorial cover. If metaphor source-image
generation is unavailable in this scheduled run, save the brief and stop.
Do not create an exact preview, do not upload anything to LinkedIn, and do not
publish. Notify me when the private draft is ready, then stop.
```

Document the two tool sequences:

```text
Statement: draft → brief → render → open review card
Metaphor: draft → brief → ChatGPT image → render with source → open review card
```

State explicitly that only the final branded PNG is attached and source art
is never published.

- [ ] **Step 5: Run the end-to-end and documentation tests**

Run:

```bash
npx vitest run tests/e2e/brand-studio-flow.test.ts tests/e2e/linkedin-image-flow.test.ts tests/build/dockerfile.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e README.md docs/deployment/supabase-railway-chatgpt.md
git commit -m "test: verify private branded schedule flow"
```

---

### Task 11: Complete local, database, dependency, and Docker verification

**Files:**
- No planned source changes.

**Interfaces:**
- Consumes the complete implementation.
- Produces evidence that the branch is safe to deploy.

- [ ] **Step 1: Check current Supabase guidance before live database work**

Fetch the current lightweight changelog and security guidance:

```bash
curl -L --fail --silent --show-error https://supabase.com/changelog.md \
  | rg -n "breaking-change|Storage|Postgres|Auth" | head -80
curl -L --fail --silent --show-error \
  https://supabase.com/docs/guides/storage/security/access-control.md \
  | rg -n "RLS|service role|authenticated|private" | head -80
```

Expected: no change requiring a service-role key, public bucket, or alteration
of the existing owner-namespaced Storage policy. If current docs contradict
the design, stop before deployment and revise the design rather than weakening
security.

- [ ] **Step 2: Run formatting-independent static verification**

Run:

```bash
git diff --check
npm run typecheck
npm run build
```

Expected: all exit 0.

- [ ] **Step 3: Run the complete suite and coverage**

Run:

```bash
npm test
npm run test:coverage
```

Expected: all tests pass; no new uncovered critical branch in hook validation,
owner checks, render cleanup, or app-only tool visibility.

- [ ] **Step 4: Audit production dependencies**

Run:

```bash
npm audit --omit=dev
```

Expected: zero known production vulnerabilities. Do not run a force upgrade;
resolve any issue with a reviewed pinned change and repeat Tasks 5–11 tests.

- [ ] **Step 5: Build and smoke the production image**

Run:

```bash
docker build -t pmm-career-mcp:brand-studio .
docker run --rm --entrypoint node pmm-career-mcp:brand-studio \
  -e "const fs=require('fs'); for (const f of [
    'CormorantGaramond-SemiBold.ttf',
    'CormorantGaramond-SemiBoldItalic.ttf',
    'Inter-Medium.ttf',
    'Inter-SemiBold.ttf'
  ]) if (!fs.existsSync('/app/assets/fonts/'+f)) process.exit(1)"
```

Expected: Docker build and asset smoke exit 0.

- [ ] **Step 6: Review the final branch**

Run:

```bash
git status --short
git log --oneline --decorate -15
git diff origin/codex/supabase-migration...HEAD --stat
```

Expected: clean worktree and only intentional Brand Studio/spec/plan commits.

- [ ] **Step 7: Stop on any verification defect**

If any verification command fails, do not patch opportunistically inside this
task. Return to the task that owns the failing behavior, add a focused failing
test there, make the smallest fix, rerun that task's complete test command,
commit with that task's prescribed message, and then restart Task 11 from
Step 1. Do not create an empty verification commit.

---

### Task 12: Deploy the verified branch and perform a private production smoke

**Files:**
- No planned source changes.

**Interfaces:**
- Produces a deployed Railway version from `codex/supabase-migration`.
- Produces live private-draft evidence without publishing to LinkedIn.

- [ ] **Step 1: Push the deployment branch**

Run:

```bash
git push origin codex/supabase-migration
```

Expected: GitHub branch `Pratikn07/pmm-career-mcp:codex/supabase-migration`
contains the verified commits.

- [ ] **Step 2: Inspect the Railway target without printing variables**

Run:

```bash
railway status
railway up --help
```

Expected: project `pmm-career-mcp`, service `pmm-career-mcp`, environment
`production`. Do not run commands that print secret variable values.

- [ ] **Step 3: Deploy the exact verified source**

Run:

```bash
railway up --detach \
  --service pmm-career-mcp \
  --environment production \
  --message "deploy PMM Brand Studio"
railway deployment list \
  --service pmm-career-mcp \
  --environment production \
  --limit 3 \
  --json
```

If the newest deployment is not successful, inspect only bounded logs:

```bash
railway logs \
  --service pmm-career-mcp \
  --environment production \
  --latest \
  --lines 100
```

Do not create a new project, service, volume, paid plan, or billable upgrade.

Expected: deployment succeeds and startup applies `0004_pmm_brand_studio`
through the existing migration URL before readiness becomes healthy.

- [ ] **Step 4: Verify health and migration readiness**

Run:

```bash
curl --fail https://pmm-career-mcp-production.up.railway.app/health
curl --fail https://pmm-career-mcp-production.up.railway.app/ready
```

Expected:

```json
{"status":"ok"}
{"status":"ready"}
```

- [ ] **Step 5: Refresh the ChatGPT connector**

In ChatGPT Developer Mode, open PMM Career MCP and press **Refresh**. Confirm
the tool list contains:

```text
get_pmm_brand_profile
create_branded_visual_brief
render_branded_linkedin_cover
```

Confirm `create_exact_linkedin_preview` and
`publish_exact_linkedin_post` remain app-only and are not suggested as normal
chat actions.

- [ ] **Step 6: Run the harmless private production smoke**

Use this prompt:

```text
Use PMM Career MCP to create a harmless private LinkedIn test draft with
CONNECTIONS visibility. Read the PMM FIELD NOTES brand profile, create a
statement brief with the hook “Clarity beats capability.”, and render the
private branded cover. Then open the non-writing review card. Do not create an
exact preview, do not upload anything to LinkedIn, do not publish, and do not
create a LinkedIn authorization URL.
```

Expected:

- the rendered cover shows `PMM FIELD NOTES`, `BHAGYASHREE NANDOSKAR`, and
  `PRODUCT MARKETING`;
- the review card reports template/profile provenance;
- the post remains a private draft;
- LinkedIn activity shows no new post.

- [ ] **Step 7: Report deployment evidence**

Record the deployed commit SHA, Railway deployment result, health/readiness
status, connector refresh result, private draft ID/version, render checksum
prefix, and explicit confirmation that nothing was previewed or published.
Do not record secrets, signed URLs, JWTs, or database connection strings.
