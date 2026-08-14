# Editorial Intelligence Review Package Design

## Goal

Turn the approved Bhagyashree Nandoskar Editorial Model card into a deterministic PMM Career MCP visual format and make scheduled post-candidate runs deliver one coherent package in this order:

1. Daily PMM intelligence brief
2. Final LinkedIn draft
3. Finished branded image
4. Exact-preview and publish controls

The scheduled run must stop at private review. It must never create an exact LinkedIn preview, upload media to LinkedIn, create a LinkedIn authorization URL, or publish. If the daily decision is not `POST CANDIDATE`, the run stops after the brief and the selected non-public action rather than manufacturing a LinkedIn post.

## Approved visual direction

The approved reference is a clean 1080×1350 editorial model card:

- Warm ivory background
- Deep navy editorial serif headline
- Restrained copper rules, arrows, numbering, and bullet accents
- Short subhead
- Three-stage model with compact bullets
- One short evidence line
- Stable footer with `BN`, `BHAGYASHREE NANDOSKAR`, and `PRODUCT MARKETING`
- No `PMM FIELD NOTES` label
- No decorative architecture, stock imagery, robots, dashboards, or generic AI imagery

The image must complement the post by making its core reasoning scannable. It must not repeat the entire post.

## Visual modes

The brand system supports four modes:

- `EDITORIAL_STATEMENT`: short hook-led statement
- `EDITORIAL_EVIDENCE`: concise evidence/signals card
- `EDITORIAL_MODEL`: a deterministic three-stage framework card
- `EDITORIAL_METAPHOR`: rare source-art mode requiring an input image

Research-led scheduled posts should prefer `EDITORIAL_MODEL` or `EDITORIAL_EVIDENCE`. `EDITORIAL_METAPHOR` is optional and should not be selected merely to add decoration.

## Editorial Model content contract

`EDITORIAL_MODEL` requires structured content:

```ts
type EditorialModelContent = Readonly<{
  kind: "model";
  subhead: string;
  stages: readonly [
    Readonly<{ number: "01"; label: string; items: readonly string[] }>,
    Readonly<{ number: "02"; label: string; items: readonly string[] }>,
    Readonly<{ number: "03"; label: string; items: readonly string[] }>
  ];
  evidenceLine: string;
}>;
```

Rules:

- Exactly three stages
- Stage numbers are exactly `01`, `02`, `03`
- Stage labels are short uppercase-compatible phrases
- Two or three short items per stage
- The subhead and evidence line are factual, cautious, and concise
- No statistics or factual claims that are not supported by the daily brief

## Editorial Evidence content contract

`EDITORIAL_EVIDENCE` requires:

```ts
type EditorialEvidenceContent = Readonly<{
  kind: "evidence";
  subhead: string;
  signals: readonly [
    Readonly<{ label: string; detail: string }>,
    Readonly<{ label: string; detail: string }>,
    Readonly<{ label: string; detail: string }>
  ];
  evidenceLine: string;
}>;
```

The renderer uses the same palette, typography, margins, and footer as the model card.

## Persistence

Add a nullable JSONB `visual_content_json` column to `career_mcp.brand_visual_briefs`.

- Model and evidence briefs require validated structured content.
- Statement and metaphor briefs must store `null`.
- Existing rows remain valid.
- The current internal `series_name` database column stays for backward compatibility, but it is not rendered or shown in the review card.

## Automatic image workflow

For a scheduled post with one branded image:

1. Save the private text draft.
2. Save the structured branded visual brief.
3. Render and attach the image, creating the next immutable post version.
4. Open the review package for that newest version with `expectedImageCount: 1`.

The model must not open the review package before the render-and-attach step succeeds. If rendering fails, it should report the incomplete package and stop safely.

## Combined review package

`open_linkedin_review_card` accepts a concise `dailyBrief` payload and `expectedImageCount`.

The card renders:

1. Daily brief: decision, strongest signal, why it matters, distinctive angle, confidence, and sources
2. Exact LinkedIn draft
3. Attached image and alt text
4. Brand provenance
5. Validation and action controls

The tool rejects opening when the selected immutable version does not contain the expected number of images. This prevents a text-only review card from being presented as a complete post-and-image package.

## Safety

- Scheduled/model-driven runs may create private drafts and private images only.
- Exact preview is created only after the user clicks the review-card button.
- Publishing is available only after an exact preview and an explicit user confirmation.
- Publishing remains single-use and non-retryable.
- No silent hook substitution or content fallback after validation failure.
- No invented personal experience, metrics, quotes, or evidence.

## Backward compatibility

- Existing statement and metaphor briefs continue to render.
- Existing review-card payloads without a daily brief remain valid.
- `expectedImageCount` is optional for manual review flows; scheduled instructions require it.
- Historical `PMM FIELD NOTES` provenance may remain stored, but new visuals and the review UI do not display it.
