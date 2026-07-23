# PMM Brand Studio Design

Date: 2026-07-22  
Status: Approved direction; implementation specification awaiting final review  
Audience: One private user operating PMM Career MCP through ChatGPT

## 1. Objective

Add a versioned personal-brand system to PMM Career MCP so ChatGPT can prepare
consistent LinkedIn visuals for Bhagyashree Nandoskar.

The visual is an editorial cover and attention hook, not a summary, diagram, or
replacement for the post. The LinkedIn caption contains the complete idea. The
cover creates curiosity while remaining honest and recognizably part of
Bhagyashree's personal Product Marketing brand.

The brand workflow must preserve the existing safety boundary:

1. A scheduled or model-driven run may research, save or revise a private post,
   create a brand brief, generate or ingest source art, render a branded cover,
   and attach the final cover to a new immutable private draft version.
2. A scheduled or model-driven run may not create an exact preview, upload media
   to LinkedIn, or publish.
3. Exact preview and publishing remain app-only actions in the human-operated
   review card.
4. Every publication still requires a current exact preview and explicit final
   human confirmation.

## 2. Confirmed creative direction

### 2.1 Brand identity

- Public name: **Bhagyashree Nandoskar**
- Role line: **Product Marketing**
- Editorial series: **PMM FIELD NOTES**
- Supporting monogram: **BN**
- Persona: curious PMM practitioner
- Tone: thoughtful, practical, observant, conversational, and
  evidence-aware
- Personal experiences may be used selectively, but the system must never
  invent clients, employers, events, outcomes, or metrics.

### 2.2 Visual character

The system uses a premium editorial language inspired by a carefully designed
business column rather than a generic social-media template:

- warm ivory background (`#F6F1E8`);
- deep ink navy (`#14233A`);
- muted copper accent (`#B97850`);
- soft taupe support (`#C9B8A5`);
- near-white highlight (`#FFFDF9`);
- an editorial serif headline;
- a clean sans-serif label and signature;
- generous whitespace;
- thin rules, restrained paper texture, and abstract cropped geometry;
- no stock-photo treatment, glossy 3D icons, generic AI gradients, or dense
  infographic styling.

The initial licensed font assets are:

- Cormorant Garamond Semibold and Semibold Italic for editorial hooks;
- Inter Medium and Semibold for labels and the signature.

The implementation must bundle the selected open-source font files and their
licenses. Production rendering must not fetch fonts from the public web.

### 2.3 The cover's job

The cover must create a truthful curiosity gap. It must not explain the post.

Examples of acceptable cover language:

- `The feature isn't the story.`
- `Clarity beats capability.`
- `More features. Less meaning.`
- `What makes a product feel necessary?`

The post may subsequently explain the underlying insight. The cover does not
include the explanation, supporting paragraphs, checklists, frameworks, or the
post's conclusion.

### 2.4 Hook rules

The server enforces the deterministic portion of the hook policy:

- 2 to 8 whitespace-delimited words;
- 72 Unicode characters or fewer after NFC normalization and trimming;
- one or two visual lines;
- no newlines supplied by the caller;
- not identical to the post's opening line;
- not identical to any complete normalized sentence in the post;
- no URLs, hashtags, list markers, emoji runs, or unverified numeric claims;
- no generic engagement bait such as `You won't believe`, `Read this`, or
  `Here's the secret`.

Creative judgment remains ChatGPT's responsibility. Tool instructions require
ChatGPT to prefer tension, contrast, an honest question, or a light visual
metaphor and to avoid giving away the post's complete answer.

## 3. Scope

### 3.1 Version-one scope

Version one creates one branded cover per post using one of two immutable
templates:

1. `editorial-statement-v1`
   - Default.
   - Large short hook and deterministic abstract geometry.
   - Does not require generated source art.

2. `editorial-metaphor-v1`
   - Short hook plus one restrained conceptual image.
   - ChatGPT generates the source artwork from the MCP's canonical prompt, or
     the user supplies an image.
   - The MCP crops and composites the source art into the locked template.

Both templates always include:

- `PMM FIELD NOTES`;
- an optional bounded topic label;
- `BN`;
- `BHAGYASHREE NANDOSKAR`;
- `PRODUCT MARKETING`.

The default output is a 1080 by 1350 pixel PNG suitable for a 4:5 LinkedIn feed
cover.

### 3.2 Deferred scope

- branded multi-slide carousels;
- a visual template editor;
- multiple people or brand profiles;
- automatic image generation from a server-side paid image API;
- remote font or stock-asset fetching;
- automatically generated portraits;
- automatic publication or scheduled publication;
- profile editing, comments, reactions, documents, or video.

The existing generic image workflow continues to support up to four images.
Brand Studio version one deliberately renders a single cover. A later carousel
design may build on the same brand profile and brief records.

## 4. Responsibilities and workflow

### 4.1 ChatGPT responsibilities

ChatGPT:

- writes or revises the post text;
- proposes the short cover hook and concept;
- chooses statement or metaphor mode, using statement mode by default;
- asks PMM Career MCP to validate and save the branded visual brief;
- when metaphor mode is selected and image generation is available, generates
  source art using the exact prompt returned by the MCP;
- passes the resulting OpenAI file reference to the renderer immediately;
- discusses revisions with the user and creates new immutable versions rather
  than mutating an approved version.

ChatGPT does not render the nameplate, typography, colors, background, or
footer into generated source art. This avoids unreliable text rendering and
keeps the brand identity deterministic.

### 4.2 PMM Career MCP responsibilities

The MCP:

- owns the active brand profile and its immutable versions;
- validates hook and topic-label constraints;
- selects a template and produces the canonical source-art prompt;
- records the post version, brand version, template version, hook, concept,
  prompt, and negative constraints;
- ingests and validates an optional generated or uploaded source image through
  the existing bounded OpenAI-file download path;
- renders the final branded PNG locally;
- stores source and rendered assets privately in Supabase Storage;
- records SHA-256 checksums and render provenance;
- attaches only the final branded PNG to a new immutable post version;
- returns the final post version for later discussion and review;
- leaves exact preview and publishing inaccessible to scheduled/model-driven
  calls.

### 4.3 LinkedIn responsibilities

LinkedIn receives no image during drafting, source-art generation, rendering,
or ordinary review-card opening.

After the user creates an exact preview and explicitly confirms publication,
the existing app-only publisher:

1. reloads the exact post version;
2. verifies text, visibility, final rendered bytes, media order, alt text, and
   the whole-post checksum;
3. uploads the final stored PNG through the LinkedIn Images API;
4. creates the exact LinkedIn post once;
5. records the result without automatic retry.

## 5. Model-visible MCP tools

### 5.1 `get_pmm_brand_profile`

Read-only. Returns the active model-safe brand rules:

- profile name and version;
- public name, role line, series name, and monogram;
- voice rules;
- palette;
- available templates;
- hook rules;
- prohibited treatments;
- recent template and hook usage summaries.

It does not return storage paths, credentials, font file paths, or private
approval material.

### 5.2 `create_branded_visual_brief`

Private, reversible write. Inputs:

- post ID;
- expected immutable post version;
- cover hook;
- concept summary;
- visual mode: `EDITORIAL_STATEMENT` or `EDITORIAL_METAPHOR`;
- optional topic label of at most 24 Unicode characters.

The tool:

- requires the expected version to still be current;
- validates the hook against the saved post and active brand profile;
- selects the corresponding template;
- saves the immutable brief;
- returns the canonical generation prompt and negative constraints;
- returns `requiresSourceImage`, which is false for statement mode and true for
  metaphor mode;
- returns a proposed alt-text draft for ChatGPT and the user to review.

This tool does not attach media, preview, upload to LinkedIn, or publish.

### 5.3 `render_branded_linkedin_cover`

Private attachment write. Inputs:

- brief ID;
- post ID;
- expected post version;
- optional OpenAI source-image file parameter;
- final alt text, one line and at most 120 Unicode characters.

The tool:

- rejects a source image in statement mode unless a future template explicitly
  permits it;
- requires a source image in metaphor mode;
- validates ownership and the exact post/brand/template versions;
- downloads and inspects the source through the existing size, MIME, pixel,
  frame, timeout, redirect, DNS, and SSRF controls;
- performs a deterministic local render;
- validates the output dimensions and PNG structure;
- stores render provenance and checksums;
- attaches the final render as the only branded cover in a new immutable post
  version;
- returns the new version and brand validation result.

This tool never creates an exact preview, uploads to LinkedIn, or publishes.

### 5.4 Existing tools

The existing tools keep their current safety and behavior:

- `draft_linkedin_post`
- `revise_post`
- `attach_linkedin_post_images`
- `set_linkedin_post_images`
- `open_linkedin_review_card`
- app-only `create_exact_linkedin_preview`
- app-only `publish_exact_linkedin_post`

`attach_linkedin_post_images` remains available for non-branded user images.
The new renderer is the preferred path for Brand Studio covers.

## 6. Canonical source-art prompt

The MCP constructs the prompt from immutable brand and brief fields. The prompt
asks for artwork only, never finished typography:

```text
Create a restrained premium editorial visual for a Product Marketing field
note. Use a warm ivory, ink navy, muted copper, and soft taupe palette. Compose
for a 4:5 LinkedIn cover with the conceptual artwork confined to the designated
template image zone and generous negative space. Express this concept through
an abstract metaphor: <concept summary>. The visual should feel thoughtful,
human, tactile, and magazine-like rather than literal or instructional.

Do not include words, letters, numbers, logos, watermarks, UI, charts,
checklists, presentation slides, stock-photo poses, glossy 3D icons, or a
literal depiction of every sentence in the post. Do not render the person's
name or the cover hook. PMM Career MCP will add all text and brand elements.
```

The exact image zone and composition instruction vary by template version.
The stored prompt includes the brand-profile, template, and prompt-format
versions so a render can be explained and reproduced.

## 7. Deterministic renderer

### 7.1 Rendering strategy

The renderer uses the existing pinned `sharp` dependency:

1. Create the 1080 by 1350 base.
2. Apply deterministic paper texture generated from a fixed algorithm and
   template seed.
3. For metaphor mode, decode, crop, and composite the source image only inside
   its image zone with a template-controlled mask and treatment.
4. Draw abstract arcs, lines, or circles from template-owned SVG assets.
5. Lay out the hook using the bundled serif font and bounded word-aware line
   breaking.
6. Add labels, full name, role line, and monogram using the bundled sans-serif
   font.
7. Encode a fresh final PNG without carrying source metadata.
8. Inspect the final bytes and calculate SHA-256 before storage.

No arbitrary caller-provided SVG, HTML, font, CSS, color, asset URL, or
position is accepted.

### 7.2 Text fitting

Because hooks are deliberately short, the renderer uses a small deterministic
layout table rather than unbounded text fitting:

- 2 to 4 words: largest size, one or two lines;
- 5 to 6 words: medium size, up to two lines;
- 7 to 8 words: smaller size, up to two lines;
- caller punctuation is preserved after normalization;
- the server owns line breaks and rejects text that cannot fit safely.

Template previews and automated render tests use the bundled production fonts.

### 7.3 Branding invariants

Every render must pass:

- exact output dimensions;
- active brand-profile and template versions recorded;
- all fixed labels present;
- full `BHAGYASHREE NANDOSKAR` signature present;
- hook within the safe text region;
- no overlap with the signature or bleed zones;
- final file is a valid bounded PNG;
- rendered SHA-256 recorded;
- non-empty reviewed alt text;
- no exact hook reuse within the configurable recent-history window unless the
  user explicitly requests reuse.

## 8. Persistence model

All records live in the private `career_mcp` PostgreSQL schema and use the
authenticated Supabase subject for ownership.

### 8.1 `brand_profiles`

- `id uuid primary key`
- `owner_subject uuid not null`
- `version integer not null`
- `state text not null` (`active` or `retired`)
- `public_name text not null`
- `role_line text not null`
- `series_name text not null`
- `monogram text not null`
- `voice_json jsonb not null`
- `palette_json jsonb not null`
- `hook_rules_json jsonb not null`
- `created_at timestamptz not null`
- unique `(owner_subject, version)`
- unique `(id, version)` for exact version references
- one active profile per owner through a partial unique index

Initial production data is seeded idempotently for the authenticated owner by
the first `create_branded_visual_brief` transaction using the immutable
code-owned version-one profile. `get_pmm_brand_profile` may return that same
effective code-owned default before the first brief exists, but remains
read-only. Initialization is never performed for an unauthenticated subject.

### 8.2 `brand_visual_briefs`

- `id uuid primary key`
- `owner_subject uuid not null`
- `post_draft_id uuid not null`
- `post_version integer not null`
- `brand_profile_id uuid not null`
- `brand_profile_version integer not null`
- `template_id text not null`
- `template_version integer not null`
- `prompt_format_version integer not null`
- `visual_mode text not null`
- `cover_hook text not null`
- `concept_summary text not null`
- `topic_label text null`
- `generation_prompt text not null`
- `negative_constraints_json jsonb not null`
- `state text not null`
- `created_at timestamptz not null`
- exact composite foreign key to the saved post version
- exact composite foreign key to the brand-profile version

### 8.3 `brand_visual_renders`

- `id uuid primary key`
- `owner_subject uuid not null`
- `brief_id uuid not null`
- `version integer not null`
- `source_media_id uuid null`
- `rendered_media_id uuid not null`
- `alt_text text not null`
- `render_checksum text not null`
- `renderer_version integer not null`
- `created_at timestamptz not null`
- unique `(brief_id, version)`
- foreign keys to private `post_media` rows

The existing `post_media` and `post_draft_media` tables remain the canonical
storage and exact-post attachment records. Source media is private but is not
attached to the LinkedIn draft. Only the rendered media ID is attached.

### 8.4 Ownership and database access

- Every service query includes `owner_subject`.
- Cross-owner brief, source, render, and profile access returns `NOT_FOUND`.
- The production runtime role receives only the required CRUD grants on the
  new tables and sequences.
- The tables are not exposed as an unauthenticated Data API.
- No service-role key is added.
- Supabase Storage continues to use the request-scoped user JWT and existing
  private-bucket RLS policies.
- No Storage policy change is required because rendered assets use the existing
  owner-namespaced `linkedin-draft-media` path and bounded storage adapter.

## 9. Review card

The existing review card displays the actual final rendered image. It gains a
compact, non-editing Brand Studio section:

- `PMM FIELD NOTES` profile version;
- template name and version;
- cover hook;
- brand validation status;
- render checksum abbreviation.

The card continues to show:

- exact post text;
- visibility;
- exact final media order;
- alt text;
- draft ID and version;
- whole-post checksum;
- preview state and expiry.

Changing the hook, template, image, alt text, post text, or visibility creates
a new immutable version and invalidates any prior preview.

## 10. Failure behavior

- If scheduled ChatGPT cannot pass its generated file, it saves the brief and
  text draft and stops. The interactive conversation may generate and render
  the image later.
- Expired OpenAI file URLs fail safely and ask for regeneration or re-upload.
- Source validation failure stores no attached draft version.
- Render failure stores no final attachment and removes unreferenced temporary
  objects best-effort.
- A stale post version or retired brand profile returns `CONFLICT`.
- Missing active brand configuration returns a safe `BRAND_NOT_CONFIGURED`
  domain error.
- A failed render never falls back to an unbranded image.
- No drafting or rendering failure permits exact preview or publishing.
- LinkedIn definite and ambiguous failure behavior remains unchanged and is
  never automatically retried.

## 11. Testing and verification

### 11.1 Unit tests

- brand-profile validation and activation;
- hook normalization, size limits, prohibited bait, and post-duplication
  checks;
- deterministic prompt construction;
- template selection;
- deterministic word-aware line breaking;
- output dimensions, format, and checksum;
- source-image-required and source-image-forbidden cases;
- owner isolation and stale-version conflicts;
- safe errors without prompt, path, or credential leakage.

### 11.2 Repository and service tests

- migrations from the current production schema;
- least-privilege runtime grants;
- exact foreign keys to post and brand versions;
- create brief, render cover, store provenance, and attach a new post version;
- rollback and cleanup on storage or database failure;
- recent hook-history query;
- signed review URLs for rendered media;
- whole-post checksum includes the exact final rendered media bytes and alt
  text through the existing media checksum contract.

### 11.3 MCP tests

- accurate read/write and open-world annotations;
- file parameter metadata on the render tool;
- scheduled/model-visible tools stop after private draft attachment;
- exact preview and publish remain app-only;
- model summaries state that nothing was previewed, uploaded to LinkedIn, or
  published;
- output schemas never expose private object paths or source download URLs.

### 11.4 End-to-end tests

1. Save a text draft.
2. Create a statement brief and render without source art.
3. Open the non-writing review card and inspect the branded cover.
4. Confirm no preview or LinkedIn network request occurred.
5. Create a metaphor brief, ingest a fixture source image, render, and attach.
6. Create an exact preview through the app-only path.
7. Verify a new draft edit invalidates the prior preview.
8. Publish through mocked LinkedIn image and post clients after explicit
   app-only approval.
9. Verify scheduled flow cannot discover or call exact preview or publish
   actions.

### 11.5 Production verification

Before enabling the new tools in the ChatGPT connector:

- run the complete automated test suite, typecheck, build, dependency audit,
  and Docker build;
- apply and verify the PostgreSQL migration through the established Railway
  startup migration path;
- verify the active brand profile for Bhagyashree Nandoskar;
- generate one harmless private statement cover and one harmless private
  metaphor cover;
- confirm both appear in the review card from private Supabase Storage;
- confirm Railway logs and MCP results contain no secrets or signed URLs;
- confirm the scheduled-flow smoke creates only a private draft and render;
- confirm exact preview and publishing still require the app-only review card;
- refresh the ChatGPT connector and inspect the new tool contracts;
- do not publish a live LinkedIn post as part of deployment verification.

## 12. Rollout

1. Add migrations, repositories, domain types, and tests.
2. Add the immutable brand profile and template registry.
3. Add canonical brief generation and hook validation.
4. Add deterministic rendering with bundled fonts and template assets.
5. Add private source/render persistence and exact draft attachment.
6. Register model-visible brand tools and schemas.
7. Extend the review card with brand provenance.
8. Complete local, Docker, and migration verification.
9. Push the deployment branch and deploy to the existing Railway service.
10. Seed/activate Bhagyashree's brand profile.
11. Refresh PMM Career MCP in ChatGPT and complete the private production smoke.

The publishing switches may remain enabled in production. They do not broaden
the model-visible tool boundary: exact preview and publish remain app-only,
one-use, human-confirmed actions.
