import type { BrandVisualMode } from "./profile.js";

export type BrandRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type BrandTextRectangles = Readonly<{
  series: BrandRectangle;
  topic: BrandRectangle;
  hook: BrandRectangle;
  signature: BrandRectangle;
  monogram: BrandRectangle;
}>;

export type BrandTemplate = Readonly<{
  id: "editorial-statement-v1" | "editorial-metaphor-v1";
  version: 1;
  mode: BrandVisualMode;
  width: 1080;
  height: 1350;
  safeTextRectangles: BrandTextRectangles;
  imageZone: BrandRectangle;
  requiresSourceImage: boolean;
}>;

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number
): BrandRectangle {
  return Object.freeze({ x, y, width, height });
}

function textRectangles(
  hook: BrandRectangle
): BrandTextRectangles {
  return Object.freeze({
    series: rectangle(96, 78, 620, 52),
    topic: rectangle(96, 158, 520, 42),
    hook,
    signature: rectangle(96, 1190, 720, 74),
    monogram: rectangle(892, 1184, 92, 92)
  });
}

export const EDITORIAL_STATEMENT_TEMPLATE: BrandTemplate = Object.freeze({
  id: "editorial-statement-v1",
  version: 1,
  mode: "EDITORIAL_STATEMENT",
  width: 1080,
  height: 1350,
  safeTextRectangles: textRectangles(rectangle(96, 300, 888, 720)),
  imageZone: rectangle(650, 260, 334, 700),
  requiresSourceImage: false
});

export const EDITORIAL_METAPHOR_TEMPLATE: BrandTemplate = Object.freeze({
  id: "editorial-metaphor-v1",
  version: 1,
  mode: "EDITORIAL_METAPHOR",
  width: 1080,
  height: 1350,
  safeTextRectangles: textRectangles(rectangle(96, 300, 450, 720)),
  imageZone: rectangle(590, 250, 394, 740),
  requiresSourceImage: true
});

const TEMPLATE_BY_MODE: Readonly<Record<BrandVisualMode, BrandTemplate>> =
  Object.freeze({
    EDITORIAL_STATEMENT: EDITORIAL_STATEMENT_TEMPLATE,
    EDITORIAL_METAPHOR: EDITORIAL_METAPHOR_TEMPLATE
  });

export function templateForMode(mode: BrandVisualMode): BrandTemplate {
  return TEMPLATE_BY_MODE[mode];
}
