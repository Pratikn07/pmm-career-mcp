export type BrandVisualMode =
  | "EDITORIAL_STATEMENT"
  | "EDITORIAL_EVIDENCE"
  | "EDITORIAL_MODEL"
  | "EDITORIAL_METAPHOR";

export type PmmBrandProfile = Readonly<{
  version: 2;
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

const VOICE_TRAITS = Object.freeze([
  "thoughtful",
  "practical",
  "observant",
  "conversational",
  "evidence-aware"
] as const);

export const DEFAULT_PMM_BRAND_PROFILE: PmmBrandProfile = Object.freeze({
  version: 2,
  publicName: "BHAGYASHREE NANDOSKAR",
  roleLine: "PRODUCT MARKETING",
  seriesName: "EDITORIAL INTELLIGENCE",
  monogram: "BN",
  voice: Object.freeze({
    persona: "curious PMM practitioner",
    traits: VOICE_TRAITS,
    neverInventExperience: true
  }),
  palette: Object.freeze({
    ivory: "#F6F1E8",
    navy: "#14233A",
    copper: "#B97850",
    taupe: "#C9B8A5",
    highlight: "#FFFDF9"
  }),
  hookRules: Object.freeze({
    minWords: 2,
    maxWords: 8,
    maxCharacters: 72,
    recentWindow: 30
  })
} as const);
