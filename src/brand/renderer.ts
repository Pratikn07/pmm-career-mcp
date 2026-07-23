import { isDeepStrictEqual } from "node:util";
import { Resvg } from "@resvg/resvg-js";
import sharp, { type OverlayOptions } from "sharp";
import { DomainError } from "../domain/errors.js";
import { fontPath } from "./assets.js";
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
const HEADLINE_FONT = "Cormorant Garamond";
const LABEL_FONT = "Inter";
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
  sourceImageBytes?: Buffer;
}>;

type HookLines = Readonly<{
  layout: HookLayout;
  lines: readonly string[];
}>;

function validationError(field: string, reason: string): DomainError {
  return new DomainError(
    "VALIDATION_ERROR",
    "Brand cover input is invalid",
    { field, reason }
  );
}

function assertCanonicalConfiguration(
  profile: PmmBrandProfile,
  template: BrandTemplate
): void {
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
}

function normalizeInline(value: string, field: string): string {
  if (typeof value !== "string") {
    throw validationError(field, "type");
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
  if (wordCount >= 2 && wordCount <= 4) {
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

const measuredWidths = new Map<string, number>();

function measuredHeadlineWidth(
  text: string,
  fontSize: number,
  italic: boolean
): number {
  const cacheKey = `${fontSize}:${italic ? "italic" : "normal"}:${text}`;
  const cached = measuredWidths.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const measurementSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="512">`,
    `<text x="8" y="${fontSize + 24}"`,
    ` font-family="${HEADLINE_FONT}" font-size="${fontSize}" font-weight="600"`,
    italic ? ` font-style="italic"` : "",
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
}

function hookLines(
  template: BrandTemplate,
  normalizedHook: string
): HookLines {
  const words = normalizedHook.split(" ");
  const tier = tierForWordCount(words.length);
  const layout = HOOK_LAYOUTS[template.id][tier];
  const safeWidth = template.safeTextRectangles.hook.width - 8;

  if (measuredHeadlineWidth(normalizedHook, layout.fontSize, false) <= safeWidth) {
    return Object.freeze({ layout, lines: Object.freeze([normalizedHook]) });
  }

  let best:
    | Readonly<{ lines: readonly [string, string]; score: number; split: number }>
    | undefined;
  for (let split = 1; split < words.length; split += 1) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    const firstWidth = measuredHeadlineWidth(first, layout.fontSize, false);
    const secondWidth = measuredHeadlineWidth(second, layout.fontSize, true);
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

function validatedSvgInput(input: RenderBrandedCoverInput): Readonly<{
  hook: string;
  topic?: string;
  hookLines: HookLines;
}> {
  assertCanonicalConfiguration(input.profile, input.template);
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

  return Object.freeze({
    hook,
    ...(topic === undefined ? {} : { topic }),
    hookLines: hookLines(input.template, hook)
  });
}

export function buildCoverSvg(input: RenderBrandedCoverInput): string {
  const { hookLines: fitted, topic } = validatedSvgInput(input);
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
    clipPath("series-safe", rectangles.series),
    clipPath("topic-safe", rectangles.topic),
    clipPath("hook-safe", rectangles.hook),
    clipPath("signature-safe", rectangles.signature),
    clipPath("monogram-safe", rectangles.monogram),
    `</defs>`,
    `<g fill="${profile.palette.navy}">`,
    `<text clip-path="url(#series-safe)" x="${rectangles.series.x}" y="${rectangles.series.y + 34}" font-family="${LABEL_FONT}" font-size="24" font-weight="600" letter-spacing="4">${escapeXml(profile.seriesName)}</text>`,
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

function textureBytes(template: BrandTemplate): Buffer {
  const bytes = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
  let state = template.id === "editorial-statement-v1"
    ? 0x42a91e37
    : 0x6d25f113;
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

async function preparedSourceImage(
  sourceImageBytes: Buffer,
  imageZone: BrandRectangle,
  palette: PmmBrandProfile["palette"]
): Promise<Buffer> {
  if (sourceImageBytes.byteLength === 0) {
    throw validationError("sourceImageBytes", "invalid");
  }

  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imageZone.width}" height="${imageZone.height}"><rect width="${imageZone.width}" height="${imageZone.height}" rx="18" fill="#fff"/></svg>`
  );
  const tint = await sharp({
    create: {
      width: imageZone.width,
      height: imageZone.height,
      channels: 4,
      background: `${palette.copper}1f`
    }
  }).png(PNG_OPTIONS).toBuffer();

  try {
    const source = sharp(sourceImageBytes, {
      animated: false,
      failOn: "error",
      limitInputPixels: 36_152_319,
      sequentialRead: true,
      unlimited: false
    });
    const metadata = await source.metadata();
    if (
      metadata.format !== "jpeg"
      && metadata.format !== "png"
      && metadata.format !== "gif"
    ) {
      throw new Error("Unsupported source image format");
    }

    return await source
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
    throw new DomainError(
      "MEDIA_VALIDATION_ERROR",
      "Brand source image validation failed"
    );
  }
}

function assertSourceImageMode(input: RenderBrandedCoverInput): void {
  const supplied = input.sourceImageBytes !== undefined;
  if (input.template.requiresSourceImage && !supplied) {
    throw validationError("sourceImageBytes", "required");
  }
  if (!input.template.requiresSourceImage && supplied) {
    throw validationError("sourceImageBytes", "not_allowed");
  }
}

export async function renderBrandedCover(
  input: RenderBrandedCoverInput
): Promise<RenderedBrandCover> {
  assertCanonicalConfiguration(input.profile, input.template);
  assertSourceImageMode(input);
  const svg = buildCoverSvg(input);
  const typography = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: explicitFontOptions(),
    shapeRendering: 2,
    textRendering: 2
  });
  const typographyPng = Buffer.from(typography.render().asPng());
  const texturePng = await sharp(textureBytes(input.template), {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 }
  }).png(PNG_OPTIONS).toBuffer();
  const composites: OverlayOptions[] = [
    { input: texturePng, left: 0, top: 0 },
    { input: geometrySvg(input), left: 0, top: 0 }
  ];

  if (input.sourceImageBytes !== undefined) {
    const source = await preparedSourceImage(
      input.sourceImageBytes,
      input.template.imageZone,
      input.profile.palette
    );
    composites.push({
      input: source,
      left: input.template.imageZone.x,
      top: input.template.imageZone.y
    });
  }
  composites.push({ input: typographyPng, left: 0, top: 0 });

  const bytes = await sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: input.profile.palette.ivory
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
      sourceImageUsed: input.sourceImageBytes !== undefined
    })
  });
}
