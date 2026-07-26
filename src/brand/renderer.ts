import { isDeepStrictEqual } from "node:util";
import { Resvg } from "@resvg/resvg-js";
import sharp, { type Metadata, type OverlayOptions } from "sharp";
import { DomainError } from "../domain/errors.js";
import { fontPath } from "./assets.js";
import {
  validateBrandVisualContent,
  type BrandVisualContent,
  type EditorialEvidenceContent,
  type EditorialModelContent
} from "./content.js";
import {
  DEFAULT_PMM_BRAND_PROFILE,
  type PmmBrandProfile
} from "./profile.js";
import {
  templateForMode,
  type BrandRectangle,
  type BrandTemplate
} from "./templates.js";

const WIDTH = 1080 as const;
const HEIGHT = 1350 as const;
const MAX_TOPIC_CHARACTERS = 24;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_AXIS = 8192;
const MAX_SOURCE_PIXELS = 36_152_319;
const MAX_SOURCE_ASPECT_RATIO = 8;
const HEADLINE_FONT = "Cormorant Garamond";
const LABEL_FONT = "Inter";
const XML_INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const FONT_FILES = [
  "CormorantGaramond-SemiBold.ttf",
  "CormorantGaramond-SemiBoldItalic.ttf",
  "Inter-Medium.ttf",
  "Inter-SemiBold.ttf"
] as const;
const PNG_OPTIONS = Object.freeze({
  adaptiveFiltering: false,
  compressionLevel: 9,
  palette: false,
  progressive: false
});

type HookTier = "2-4" | "5-6" | "7-8";
type SourceImageFormat = "gif" | "jpeg" | "png";

type HookLayout = Readonly<{
  fontSize: number;
  lineHeight: number;
  tier: HookTier;
}>;

const HOOK_LAYOUTS = Object.freeze({
  "editorial-statement-v1": Object.freeze({
    "2-4": Object.freeze({ fontSize: 112, lineHeight: 124, tier: "2-4" }),
    "5-6": Object.freeze({ fontSize: 96, lineHeight: 108, tier: "5-6" }),
    "7-8": Object.freeze({ fontSize: 82, lineHeight: 94, tier: "7-8" })
  }),
  "editorial-evidence-v1": Object.freeze({
    "2-4": Object.freeze({ fontSize: 98, lineHeight: 106, tier: "2-4" }),
    "5-6": Object.freeze({ fontSize: 88, lineHeight: 96, tier: "5-6" }),
    "7-8": Object.freeze({ fontSize: 78, lineHeight: 86, tier: "7-8" })
  }),
  "editorial-model-v1": Object.freeze({
    "2-4": Object.freeze({ fontSize: 106, lineHeight: 106, tier: "2-4" }),
    "5-6": Object.freeze({ fontSize: 98, lineHeight: 98, tier: "5-6" }),
    "7-8": Object.freeze({ fontSize: 88, lineHeight: 90, tier: "7-8" })
  }),
  "editorial-metaphor-v1": Object.freeze({
    "2-4": Object.freeze({ fontSize: 72, lineHeight: 82, tier: "2-4" }),
    "5-6": Object.freeze({ fontSize: 64, lineHeight: 74, tier: "5-6" }),
    "7-8": Object.freeze({ fontSize: 56, lineHeight: 66, tier: "7-8" })
  })
} satisfies Readonly<Record<BrandTemplate["id"], Readonly<Record<HookTier, HookLayout>>>>);

export type RenderedBrandCover = Readonly<{
  bytes: Buffer;
  mimeType: "image/png";
  width: 1080;
  height: 1350;
  validation: Readonly<{
    fixedLabelsPresent: true;
    textWithinSafeArea: true;
    sourceImageUsed: boolean;
  }>;
}>;

export type RenderBrandedCoverInput = Readonly<{
  profile: PmmBrandProfile;
  template: BrandTemplate;
  coverHook: string;
  topicLabel?: string;
  visualContent?: BrandVisualContent;
  sourceImageBytes?: Buffer;
}>;

type HookLines = Readonly<{
  layout: HookLayout;
  lines: readonly string[];
}>;

type TextMeasurementStyle = Readonly<{
  fontFamily: typeof HEADLINE_FONT | typeof LABEL_FONT;
  fontSize: number;
  fontWeight: 500 | 600;
  italic?: boolean;
  letterSpacing?: number;
}>;

type TextMeasurer = (
  text: string,
  style: TextMeasurementStyle
) => number;

function validationError(field: string, reason: string): DomainError {
  return new DomainError(
    "VALIDATION_ERROR",
    "Brand cover input is invalid",
    { field, reason }
  );
}

function sourceImageValidationError(reason: string): DomainError {
  return new DomainError(
    "MEDIA_VALIDATION_ERROR",
    "Brand source image validation failed",
    { field: "sourceImageBytes", reason }
  );
}

function canonicalBrandConfiguration(
  profile: PmmBrandProfile,
  template: BrandTemplate
): Readonly<{
  profile: PmmBrandProfile;
  template: BrandTemplate;
}> {
  if (!isDeepStrictEqual(profile, DEFAULT_PMM_BRAND_PROFILE)) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Brand profile configuration is invalid",
      { entity: "brand_profile" }
    );
  }

  const canonicalTemplate = templateForMode(template.mode);
  if (!isDeepStrictEqual(template, canonicalTemplate)) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Brand template configuration is invalid",
      { entity: "brand_template" }
    );
  }
  return Object.freeze({
    profile: DEFAULT_PMM_BRAND_PROFILE,
    template: canonicalTemplate
  });
}

function canonicalTextInput(
  input: RenderBrandedCoverInput
): RenderBrandedCoverInput {
  const { profile, template } = canonicalBrandConfiguration(
    input.profile,
    input.template
  );
  const coverHook = input.coverHook;
  const topicLabel = input.topicLabel;
  const visualContent = validateBrandVisualContent(
    template.mode,
    input.visualContent
  );
  return Object.freeze({
    profile,
    template,
    coverHook,
    ...(topicLabel === undefined ? {} : { topicLabel }),
    ...(visualContent === undefined ? {} : { visualContent })
  });
}

function canonicalRenderInput(
  input: RenderBrandedCoverInput
): RenderBrandedCoverInput {
  const textInput = canonicalTextInput(input);
  const sourceImageBytes = validatedSourceImageSnapshot(
    input.sourceImageBytes,
    textInput.template
  );
  return Object.freeze({
    ...textInput,
    ...(sourceImageBytes === undefined ? {} : { sourceImageBytes })
  });
}

function validatedSourceImageSnapshot(
  sourceImageBytes: Buffer | undefined,
  template: BrandTemplate
): Buffer | undefined {
  if (!template.requiresSourceImage) {
    if (sourceImageBytes !== undefined) {
      throw validationError("sourceImageBytes", "not_allowed");
    }
    return undefined;
  }
  if (sourceImageBytes === undefined) {
    throw validationError("sourceImageBytes", "required");
  }
  if (!Buffer.isBuffer(sourceImageBytes)) {
    throw validationError("sourceImageBytes", "type");
  }
  if (sourceImageBytes.byteLength === 0) {
    throw sourceImageValidationError("required");
  }
  if (sourceImageBytes.byteLength > MAX_SOURCE_BYTES) {
    throw sourceImageValidationError("byte_size");
  }
  return Buffer.from(sourceImageBytes);
}

function normalizeInline(value: string, field: string): string {
  if (typeof value !== "string") {
    throw validationError(field, "type");
  }
  if (XML_INVALID_CONTROL.test(value)) {
    throw validationError(field, "xml_control");
  }
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function explicitFontOptions() {
  return {
    fontFiles: FONT_FILES.map((name) => fontPath(name)),
    loadSystemFonts: false,
    defaultFontFamily: LABEL_FONT
  };
}

function tierForWordCount(wordCount: number): HookTier {
  if (wordCount < 2 || wordCount > 8) {
    throw validationError("coverHook", "word_count");
  }
  if (wordCount <= 4) {
    return "2-4";
  }
  if (wordCount <= 6) {
    return "5-6";
  }
  if (wordCount <= 8) {
    return "7-8";
  }
  throw validationError("coverHook", "word_count");
}

function createTextMeasurer(): TextMeasurer {
  const measuredWidths = new Map<string, number>();
  return (text, style) => {
    const cacheKey = [
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.italic === true ? "italic" : "normal",
      style.letterSpacing ?? 0,
      text
    ].join(":");
    const cached = measuredWidths.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const measurementSvg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="512">`,
      `<text x="8" y="${style.fontSize + 24}"`,
      ` font-family="${style.fontFamily}" font-size="${style.fontSize}" font-weight="${style.fontWeight}"`,
      style.italic === true ? ` font-style="italic"` : "",
      style.letterSpacing === undefined
        ? ""
        : ` letter-spacing="${style.letterSpacing}"`,
      `>${escapeXml(text)}</text></svg>`
    ].join("");
    const measurement = new Resvg(measurementSvg, {
      font: explicitFontOptions(),
      fitTo: { mode: "original" },
      textRendering: 2
    });
    const width = measurement.getBBox()?.width;
    if (width === undefined || !Number.isFinite(width)) {
      throw new DomainError(
        "DATA_INTEGRITY",
        "Brand typography could not be measured",
        { entity: "brand_renderer" }
      );
    }
    measuredWidths.set(cacheKey, width);
    return width;
  };
}

function hookLines(
  template: BrandTemplate,
  normalizedHook: string,
  measureText: TextMeasurer
): HookLines {
  const words = normalizedHook.split(" ");
  const tier = tierForWordCount(words.length);
  const layout = HOOK_LAYOUTS[template.id][tier];
  const safeWidth = template.safeTextRectangles.hook.width - 8;

  const headlineStyle = {
    fontFamily: HEADLINE_FONT,
    fontSize: layout.fontSize,
    fontWeight: 600
  } as const;
  if (measureText(normalizedHook, headlineStyle) <= safeWidth) {
    return Object.freeze({ layout, lines: Object.freeze([normalizedHook]) });
  }

  let best:
    | Readonly<{ lines: readonly [string, string]; score: number; split: number }>
    | undefined;
  for (let split = 1; split < words.length; split += 1) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    const firstWidth = measureText(first, headlineStyle);
    const secondWidth = measureText(second, {
      ...headlineStyle,
      italic: true
    });
    if (firstWidth > safeWidth || secondWidth > safeWidth) {
      continue;
    }

    const score = Math.max(firstWidth, secondWidth) * 2
      + Math.abs(firstWidth - secondWidth);
    if (
      best === undefined
      || score < best.score
      || (score === best.score && split < best.split)
    ) {
      const lines: readonly [string, string] = Object.freeze([first, second]);
      best = Object.freeze({
        lines,
        score,
        split
      });
    }
  }

  if (best === undefined) {
    throw validationError("coverHook", "text_fit");
  }
  return Object.freeze({ layout, lines: best.lines });
}

function clipPath(id: string, rectangle: BrandRectangle): string {
  return `<clipPath id="${id}"><rect x="${rectangle.x}" y="${rectangle.y}" width="${rectangle.width}" height="${rectangle.height}"/></clipPath>`;
}

function validatedSvgInput(
  input: RenderBrandedCoverInput,
  measureText: TextMeasurer
): Readonly<{
  hook: string;
  topic?: string;
  hookLines: HookLines;
}> {
  const hook = normalizeInline(input.coverHook, "coverHook");
  const characterCount = [...hook].length;
  if (
    characterCount === 0
    || characterCount > input.profile.hookRules.maxCharacters
  ) {
    throw validationError("coverHook", "character_count");
  }

  const topic = input.topicLabel === undefined
    ? undefined
    : normalizeInline(input.topicLabel, "topicLabel");
  if (
    topic !== undefined
    && (topic.length === 0 || [...topic].length > MAX_TOPIC_CHARACTERS)
  ) {
    throw validationError("topicLabel", "character_count");
  }
  if (
    topic !== undefined
    && measureText(topic, {
      fontFamily: LABEL_FONT,
      fontSize: 20,
      fontWeight: 500,
      letterSpacing: 3
    }) > input.template.safeTextRectangles.topic.width
  ) {
    throw validationError("topicLabel", "text_fit");
  }

  return Object.freeze({
    hook,
    ...(topic === undefined ? {} : { topic }),
    hookLines: hookLines(input.template, hook, measureText)
  });
}

function buildCanonicalCoverSvg(input: RenderBrandedCoverInput): string {
  if (input.template.mode === "EDITORIAL_MODEL") {
    return buildEditorialModelSvg(
      input,
      input.visualContent as EditorialModelContent
    );
  }
  if (input.template.mode === "EDITORIAL_EVIDENCE") {
    return buildEditorialEvidenceSvg(
      input,
      input.visualContent as EditorialEvidenceContent
    );
  }
  const { hookLines: fitted, topic } = validatedSvgInput(
    input,
    createTextMeasurer()
  );
  const { profile, template } = input;
  const rectangles = template.safeTextRectangles;
  const blockHeight = fitted.layout.fontSize
    + (fitted.lines.length - 1) * fitted.layout.lineHeight;
  const firstBaseline = rectangles.hook.y
    + (rectangles.hook.height - blockHeight) / 2
    + fitted.layout.fontSize * 0.8;
  const hookText = fitted.lines.map((line, index) => {
    const y = firstBaseline + index * fitted.layout.lineHeight;
    return [
      `<tspan data-hook-line="${index + 1}" x="${rectangles.hook.x + 4}" y="${y}"`,
      index === 1 ? ` font-style="italic"` : "",
      `>${escapeXml(line)}</tspan>`
    ].join("");
  }).join("");
  const topicText = topic === undefined
    ? ""
    : `<text clip-path="url(#topic-safe)" x="${rectangles.topic.x}" y="${rectangles.topic.y + 28}" font-family="${LABEL_FONT}" font-size="20" font-weight="500" letter-spacing="3" fill="${profile.palette.copper}">${escapeXml(topic)}</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<defs>`,
    clipPath("topic-safe", rectangles.topic),
    clipPath("hook-safe", rectangles.hook),
    clipPath("signature-safe", rectangles.signature),
    clipPath("monogram-safe", rectangles.monogram),
    `</defs>`,
    `<g fill="${profile.palette.navy}">`,
    topicText,
    `<text data-hook-tier="${fitted.layout.tier}" clip-path="url(#hook-safe)" font-family="${HEADLINE_FONT}" font-size="${fitted.layout.fontSize}" font-weight="600">${hookText}</text>`,
    `<g clip-path="url(#signature-safe)" font-family="${LABEL_FONT}">`,
    `<text x="${rectangles.signature.x}" y="${rectangles.signature.y + 29}" font-size="21" font-weight="600" letter-spacing="2.2">${escapeXml(profile.publicName)}</text>`,
    `<text x="${rectangles.signature.x}" y="${rectangles.signature.y + 61}" font-size="16" font-weight="500" letter-spacing="3.4" fill="${profile.palette.copper}">${escapeXml(profile.roleLine)}</text>`,
    `</g>`,
    `<g clip-path="url(#monogram-safe)">`,
    `<circle cx="${rectangles.monogram.x + rectangles.monogram.width / 2}" cy="${rectangles.monogram.y + rectangles.monogram.height / 2}" r="${rectangles.monogram.width / 2 - 2}" fill="${profile.palette.navy}"/>`,
    `<text x="${rectangles.monogram.x + rectangles.monogram.width / 2}" y="${rectangles.monogram.y + 58}" text-anchor="middle" font-family="${LABEL_FONT}" font-size="25" font-weight="600" letter-spacing="1.5" fill="${profile.palette.highlight}">${escapeXml(profile.monogram)}</text>`,
    `</g>`,
    `</g></svg>`
  ].join("");
}

function wrappedLines(
  value: string,
  maximumWidth: number,
  maximumLines: number,
  style: TextMeasurementStyle,
  measureText: TextMeasurer
): readonly string[] {
  const words = value.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measureText(candidate, style) <= maximumWidth) {
      current = candidate;
      continue;
    }
    if (current.length === 0 || lines.length >= maximumLines - 1) {
      throw validationError("visualContent", "text_fit");
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  if (
    lines.length > maximumLines
    || lines.some((line) => measureText(line, style) > maximumWidth)
  ) {
    throw validationError("visualContent", "text_fit");
  }
  return Object.freeze(lines);
}

function svgTextLines(
  lines: readonly string[],
  x: number,
  firstBaseline: number,
  lineHeight: number,
  attributes: string
): string {
  return lines.map((line, index) =>
    `<text x="${x}" y="${firstBaseline + index * lineHeight}" ${attributes}>${escapeXml(line)}</text>`
  ).join("");
}

function structuredHeadline(
  input: RenderBrandedCoverInput,
  measureText: TextMeasurer
): Readonly<{ text: string; svg: string; bottom: number }> {
  const text = normalizeInline(input.coverHook, "coverHook").toLocaleUpperCase(
    "en-US"
  );
  const characterCount = [...text].length;
  if (
    characterCount < 1
    || characterCount > input.profile.hookRules.maxCharacters
  ) {
    throw validationError("coverHook", "character_count");
  }
  tierForWordCount(text.split(" ").length);
  const style = {
    fontFamily: HEADLINE_FONT,
    fontSize: 102,
    fontWeight: 600
  } as const;
  const lines = wrappedLines(text, 830, 4, style, measureText);
  const firstBaseline = 170;
  const lineHeight = 100;
  return Object.freeze({
    text,
    svg: [
      `<g data-cover-hook="${escapeXml(text)}" font-family="${HEADLINE_FONT}" font-size="102" font-weight="600" fill="${input.profile.palette.navy}">`,
      svgTextLines(lines, 96, firstBaseline, lineHeight, ""),
      `</g>`
    ].join(""),
    bottom: firstBaseline + (lines.length - 1) * lineHeight + 32
  });
}

function structuredFooter(input: RenderBrandedCoverInput): string {
  const { profile } = input;
  return [
    `<line x1="96" y1="1222" x2="984" y2="1222" stroke="${profile.palette.copper}" stroke-width="1.5"/>`,
    `<text x="96" y="1300" font-family="${HEADLINE_FONT}" font-size="68" font-weight="600" fill="${profile.palette.copper}">${escapeXml(profile.monogram)}</text>`,
    `<line x1="205" y1="1246" x2="205" y2="1310" stroke="${profile.palette.copper}" stroke-width="1.5"/>`,
    `<text x="236" y="1270" font-family="${LABEL_FONT}" font-size="19" font-weight="600" letter-spacing="1.6" fill="${profile.palette.navy}">${escapeXml(profile.publicName)}</text>`,
    `<text x="236" y="1303" font-family="${LABEL_FONT}" font-size="15" font-weight="500" letter-spacing="3.2" fill="${profile.palette.navy}">${escapeXml(profile.roleLine)}</text>`
  ].join("");
}

function structuredSubhead(
  value: string,
  y: number,
  input: RenderBrandedCoverInput,
  measureText: TextMeasurer
): Readonly<{ svg: string; bottom: number }> {
  const style = {
    fontFamily: LABEL_FONT,
    fontSize: 25,
    fontWeight: 500,
    letterSpacing: 1.2
  } as const;
  const lines = wrappedLines(value, 800, 2, style, measureText);
  return Object.freeze({
    svg: [
      `<g data-subhead="${escapeXml(value)}" font-family="${LABEL_FONT}" font-size="25" font-weight="500" letter-spacing="1.2" fill="${input.profile.palette.navy}">`,
      svgTextLines(lines, 96, y, 34, ""),
      `</g>`
    ].join(""),
    bottom: y + (lines.length - 1) * 34 + 12
  });
}

function evidenceLineSvg(
  value: string,
  input: RenderBrandedCoverInput,
  measureText: TextMeasurer
): string {
  const style = {
    fontFamily: LABEL_FONT,
    fontSize: 16,
    fontWeight: 500
  } as const;
  const lines = wrappedLines(value, 770, 2, style, measureText);
  return [
    `<line x1="96" y1="1154" x2="984" y2="1154" stroke="${input.profile.palette.taupe}" stroke-width="1.5" stroke-dasharray="2 5"/>`,
    `<circle cx="110" cy="1188" r="6" fill="${input.profile.palette.copper}"/>`,
    `<g data-evidence-line="${escapeXml(value)}" font-family="${LABEL_FONT}" font-size="16" font-weight="500" fill="${input.profile.palette.navy}">`,
    svgTextLines(lines, 130, 1194, 23, ""),
    `</g>`
  ].join("");
}

function buildEditorialModelSvg(
  input: RenderBrandedCoverInput,
  content: EditorialModelContent
): string {
  const measureText = createTextMeasurer();
  const headline = structuredHeadline(input, measureText);
  const ruleY = headline.bottom + 22;
  const subhead = structuredSubhead(
    content.subhead,
    ruleY + 58,
    input,
    measureText
  );
  const stageTop = Math.max(720, subhead.bottom + 62);
  const columnWidth = 260;
  const columnGap = 55;
  const columnXs = [96, 96 + columnWidth + columnGap, 96 + 2 * (columnWidth + columnGap)];
  const stageSvg = content.stages.map((stage, stageIndex) => {
    const x = columnXs[stageIndex]!;
    let labelLines: readonly string[] | undefined;
    let labelFontSize: number | undefined;
    for (const fontSize of [18, 16, 14, 12, 10] as const) {
      try {
        labelLines = wrappedLines(
          stage.label,
          210,
          2,
          {
            fontFamily: LABEL_FONT,
            fontSize,
            fontWeight: 600,
            letterSpacing: 2.2
          },
          measureText
        );
        labelFontSize = fontSize;
        break;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") {
          throw error;
        }
      }
    }
    if (labelLines === undefined || labelFontSize === undefined) {
      throw validationError("visualContent", "text_fit");
    }
    const labelSvg = [
      `<g data-model-stage-label="${escapeXml(stage.label)}" font-family="${LABEL_FONT}" font-size="${labelFontSize}" font-weight="600" letter-spacing="2.2" fill="${input.profile.palette.navy}">`,
      svgTextLines(labelLines, x, stageTop + 96, 22, ""),
      `</g>`
    ].join("");
    const itemSvg = stage.items.map((item, itemIndex) => {
      const style = {
        fontFamily: LABEL_FONT,
        fontSize: 18,
        fontWeight: 500
      } as const;
      const lines = wrappedLines(item, 220, 2, style, measureText);
      const y = stageTop + 180 + itemIndex * 62;
      return [
        `<circle cx="${x + 6}" cy="${y - 6}" r="4" fill="${input.profile.palette.copper}"/>`,
        `<g data-model-item="${escapeXml(item)}" font-family="${LABEL_FONT}" font-size="18" font-weight="500" fill="${input.profile.palette.navy}">`,
        svgTextLines(lines, x + 22, y, 24, ""),
        `</g>`
      ].join("");
    }).join("");
    return [
      `<circle cx="${x + 42}" cy="${stageTop + 28}" r="28" fill="none" stroke="${input.profile.palette.copper}" stroke-width="1.5"/>`,
      `<text x="${x + 42}" y="${stageTop + 36}" text-anchor="middle" font-family="${HEADLINE_FONT}" font-size="24" font-weight="600" fill="${input.profile.palette.copper}">${stage.number}</text>`,
      labelSvg,
      `<line x1="${x}" y1="${stageTop + 144}" x2="${x + 210}" y2="${stageTop + 144}" stroke="${input.profile.palette.copper}" stroke-width="1.5"/>`,
      itemSvg
    ].join("");
  }).join("");
  const arrowSvg = [0, 1].map((index) => {
    const x1 = columnXs[index]! + 195;
    const x2 = columnXs[index + 1]! + 10;
    const y = stageTop + 28;
    return [
      `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${input.profile.palette.copper}" stroke-width="1.5"/>`,
      `<path d="M${x2 - 9} ${y - 7} L${x2} ${y} L${x2 - 9} ${y + 7}" fill="none" stroke="${input.profile.palette.copper}" stroke-width="1.5"/>`
    ].join("");
  }).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    headline.svg,
    `<line x1="96" y1="${ruleY}" x2="665" y2="${ruleY}" stroke="${input.profile.palette.copper}" stroke-width="2"/>`,
    `<circle cx="665" cy="${ruleY}" r="5" fill="${input.profile.palette.copper}"/>`,
    subhead.svg,
    arrowSvg,
    stageSvg,
    evidenceLineSvg(content.evidenceLine, input, measureText),
    structuredFooter(input),
    `</svg>`
  ].join("");
}

function buildEditorialEvidenceSvg(
  input: RenderBrandedCoverInput,
  content: EditorialEvidenceContent
): string {
  const measureText = createTextMeasurer();
  const headline = structuredHeadline(input, measureText);
  const ruleY = headline.bottom + 22;
  const subhead = structuredSubhead(
    content.subhead,
    ruleY + 58,
    input,
    measureText
  );
  const signalTop = Math.max(675, subhead.bottom + 62);
  const signals = content.signals.map((signal, index) => {
    const y = signalTop + index * 142;
    const detailStyle = {
      fontFamily: LABEL_FONT,
      fontSize: 20,
      fontWeight: 500
    } as const;
    const detailLines = wrappedLines(
      signal.detail,
      715,
      2,
      detailStyle,
      measureText
    );
    return [
      `<circle cx="126" cy="${y}" r="25" fill="none" stroke="${input.profile.palette.copper}" stroke-width="1.5"/>`,
      `<text x="126" y="${y + 8}" text-anchor="middle" font-family="${HEADLINE_FONT}" font-size="23" font-weight="600" fill="${input.profile.palette.copper}">0${index + 1}</text>`,
      `<text x="178" y="${y - 7}" font-family="${LABEL_FONT}" font-size="17" font-weight="600" letter-spacing="2.1" fill="${input.profile.palette.navy}">${escapeXml(signal.label)}</text>`,
      `<g data-evidence-signal="${escapeXml(signal.detail)}" font-family="${LABEL_FONT}" font-size="20" font-weight="500" fill="${input.profile.palette.navy}">`,
      svgTextLines(detailLines, 178, y + 28, 27, ""),
      `</g>`,
      `<line x1="178" y1="${y + 76}" x2="948" y2="${y + 76}" stroke="${input.profile.palette.taupe}" stroke-width="1"/>`
    ].join("");
  }).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    headline.svg,
    `<line x1="96" y1="${ruleY}" x2="665" y2="${ruleY}" stroke="${input.profile.palette.copper}" stroke-width="2"/>`,
    `<circle cx="665" cy="${ruleY}" r="5" fill="${input.profile.palette.copper}"/>`,
    subhead.svg,
    signals,
    evidenceLineSvg(content.evidenceLine, input, measureText),
    structuredFooter(input),
    `</svg>`
  ].join("");
}

export function buildCoverSvg(input: RenderBrandedCoverInput): string {
  return buildCanonicalCoverSvg(canonicalTextInput(input));
}

function textureBytes(template: BrandTemplate): Buffer {
  const bytes = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
  let state = {
    "editorial-statement-v1": 0x42a91e37,
    "editorial-evidence-v1": 0x194d3f77,
    "editorial-model-v1": 0x37d2bc91,
    "editorial-metaphor-v1": 0x6d25f113
  }[template.id];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const grain = state >>> 0;
    bytes[offset] = 20;
    bytes[offset + 1] = 35;
    bytes[offset + 2] = 58;
    bytes[offset + 3] = 2 + (grain & 0x03);
  }
  return bytes;
}

function geometrySvg(input: RenderBrandedCoverInput): Buffer {
  const { palette } = input.profile;
  const { imageZone } = input.template;
  if (
    input.template.mode === "EDITORIAL_MODEL"
    || input.template.mode === "EDITORIAL_EVIDENCE"
  ) {
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"></svg>`
    );
  }
  const shared = [
    `<line x1="96" y1="224" x2="984" y2="224" stroke="${palette.taupe}" stroke-width="2"/>`,
    `<line x1="96" y1="1153" x2="984" y2="1153" stroke="${palette.taupe}" stroke-width="2"/>`
  ];
  const templateGeometry = input.template.id === "editorial-statement-v1"
    ? [
        `<defs><clipPath id="image-geometry"><rect x="${imageZone.x}" y="${imageZone.y}" width="${imageZone.width}" height="${imageZone.height}"/></clipPath></defs>`,
        `<g clip-path="url(#image-geometry)">`,
        `<circle cx="824" cy="1010" r="202" fill="none" stroke="${palette.taupe}" stroke-width="46" opacity="0.58"/>`,
        `<circle cx="910" cy="1010" r="118" fill="none" stroke="${palette.copper}" stroke-width="12"/>`,
        `<path d="M96 1064 C286 924 482 924 674 1064" fill="none" stroke="${palette.navy}" stroke-width="16"/>`,
        `<circle cx="170" cy="1018" r="26" fill="${palette.copper}"/>`,
        `</g>`
      ]
    : [
        `<rect x="${imageZone.x - 16}" y="${imageZone.y - 16}" width="${imageZone.width + 32}" height="${imageZone.height + 32}" rx="30" fill="${palette.taupe}" opacity="0.34"/>`,
        `<path d="M546 824 C488 866 462 926 470 1000" fill="none" stroke="${palette.copper}" stroke-width="12"/>`,
        `<circle cx="478" cy="1028" r="13" fill="${palette.navy}"/>`
      ];

  return Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    ...shared,
    ...templateGeometry,
    `</svg>`
  ].join(""));
}

function sourceImageFormat(sourceImageBytes: Buffer): SourceImageFormat {
  if (
    sourceImageBytes.byteLength >= 8
    && sourceImageBytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return "png";
  }
  if (
    sourceImageBytes.byteLength >= 3
    && sourceImageBytes[0] === 0xff
    && sourceImageBytes[1] === 0xd8
    && sourceImageBytes[2] === 0xff
  ) {
    return "jpeg";
  }
  const gifSignature = sourceImageBytes.subarray(0, 6).toString("ascii");
  if (gifSignature === "GIF87a" || gifSignature === "GIF89a") {
    return "gif";
  }
  throw sourceImageValidationError("signature");
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function validateSourceMetadata(
  metadata: Metadata,
  expectedFormat: SourceImageFormat
): void {
  if (metadata.format !== expectedFormat) {
    throw sourceImageValidationError("signature");
  }
  if (
    !positiveInteger(metadata.width)
    || !positiveInteger(metadata.height)
    || metadata.width > MAX_SOURCE_AXIS
    || metadata.height > MAX_SOURCE_AXIS
  ) {
    throw sourceImageValidationError("dimensions");
  }

  const decodedPixels = metadata.width * metadata.height;
  if (
    !Number.isSafeInteger(decodedPixels)
    || decodedPixels > MAX_SOURCE_PIXELS
  ) {
    throw sourceImageValidationError("pixel_count");
  }
  if (
    metadata.width > metadata.height * MAX_SOURCE_ASPECT_RATIO
    || metadata.height > metadata.width * MAX_SOURCE_ASPECT_RATIO
  ) {
    throw sourceImageValidationError("aspect_ratio");
  }

  const pageCount = metadata.pages ?? 1;
  if (
    pageCount !== 1
    || (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
  ) {
    throw sourceImageValidationError("frame_count");
  }
}

async function preparedSourceImage(
  sourceImageBytes: Buffer,
  expectedFormat: SourceImageFormat,
  imageZone: BrandRectangle,
  palette: PmmBrandProfile["palette"]
): Promise<Buffer> {
  let metadata: Metadata;
  try {
    metadata = await sharp(sourceImageBytes, {
      animated: true,
      failOn: "error",
      limitInputPixels: false,
      sequentialRead: true,
      unlimited: false
    }).metadata();
  } catch {
    throw sourceImageValidationError("decode");
  }
  validateSourceMetadata(metadata, expectedFormat);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageZone.width}" height="${imageZone.height}"><rect width="${imageZone.width}" height="${imageZone.height}" rx="18" fill="#fff"/></svg>`
  );

  try {
    const tint = await sharp({
      create: {
        width: imageZone.width,
        height: imageZone.height,
        channels: 4,
        background: `${palette.copper}1f`
      }
    }).png(PNG_OPTIONS).toBuffer();
    return await sharp(sourceImageBytes, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_SOURCE_PIXELS,
      sequentialRead: true,
      unlimited: false
    })
      .rotate()
      .resize(imageZone.width, imageZone.height, {
        fastShrinkOnLoad: false,
        fit: "cover",
        kernel: "lanczos3",
        position: "centre"
      })
      .removeAlpha()
      .modulate({ brightness: 1.02, saturation: 0.62 })
      .ensureAlpha()
      .composite([
        { input: tint, blend: "multiply" },
        { input: mask, blend: "dest-in" }
      ])
      .png(PNG_OPTIONS)
      .toBuffer();
  } catch {
    throw sourceImageValidationError("decode");
  }
}

export async function renderBrandedCover(
  input: RenderBrandedCoverInput
): Promise<RenderedBrandCover> {
  const canonicalInput = canonicalRenderInput(input);
  const sourceFormat = canonicalInput.sourceImageBytes === undefined
    ? undefined
    : sourceImageFormat(canonicalInput.sourceImageBytes);
  const svg = buildCanonicalCoverSvg(canonicalInput);
  const typography = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: explicitFontOptions(),
    shapeRendering: 2,
    textRendering: 2
  });
  const typographyPng = Buffer.from(typography.render().asPng());
  const texturePng = await sharp(textureBytes(canonicalInput.template), {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 }
  }).png(PNG_OPTIONS).toBuffer();
  const composites: OverlayOptions[] = [
    { input: texturePng, left: 0, top: 0 },
    { input: geometrySvg(canonicalInput), left: 0, top: 0 }
  ];

  if (
    canonicalInput.sourceImageBytes !== undefined
    && sourceFormat !== undefined
  ) {
    const source = await preparedSourceImage(
      canonicalInput.sourceImageBytes,
      sourceFormat,
      canonicalInput.template.imageZone,
      canonicalInput.profile.palette
    );
    composites.push({
      input: source,
      left: canonicalInput.template.imageZone.x,
      top: canonicalInput.template.imageZone.y
    });
  }
  composites.push({ input: typographyPng, left: 0, top: 0 });

  const bytes = await sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: canonicalInput.profile.palette.ivory
    }
  })
    .composite(composites)
    .png(PNG_OPTIONS)
    .toBuffer();
  const metadata = await sharp(bytes).metadata();
  if (
    metadata.format !== "png"
    || metadata.width !== WIDTH
    || metadata.height !== HEIGHT
    || !bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Brand cover rendering failed validation",
      { entity: "brand_renderer" }
    );
  }

  return Object.freeze({
    bytes,
    mimeType: "image/png",
    width: WIDTH,
    height: HEIGHT,
    validation: Object.freeze({
      fixedLabelsPresent: true,
      textWithinSafeArea: true,
      sourceImageUsed: canonicalInput.sourceImageBytes !== undefined
    })
  });
}
