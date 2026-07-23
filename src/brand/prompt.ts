import { DomainError } from "../domain/errors.js";
import type { PmmBrandProfile } from "./profile.js";
import type { BrandTemplate } from "./templates.js";

export type SourceArtPrompt = Readonly<{
  formatVersion: 1;
  generationPrompt: string;
  negativeConstraints: readonly string[];
}>;

const LINE_CONTROL = /[\r\n\v\f\u0085\u2028\u2029]+/gu;

const NEGATIVE_CONSTRAINTS = Object.freeze([
  "readable text",
  "words, letters, or numbers",
  "names, logos, or watermarks",
  "UI, charts, lists, checklists, infographics, or presentation slides",
  "stock-photo poses, glossy 3D icons, or generic AI gradients",
  "a literal or complete explanation of the post"
] as const);

function fail(reason: "character_count" | "identity_text"): never {
  throw new DomainError(
    "VALIDATION_ERROR",
    "Concept summary does not meet the source-art rules.",
    { field: "conceptSummary", reason }
  );
}

function normalizeConcept(conceptSummary: string): string {
  if (typeof conceptSummary !== "string") {
    fail("character_count");
  }
  const normalized = conceptSummary
    .normalize("NFC")
    .replace(LINE_CONTROL, " ")
    .trim()
    .replace(/\s+/gu, " ");
  const characterCount = [...normalized].length;
  if (characterCount < 1 || characterCount > 500) {
    fail("character_count");
  }
  return normalized;
}

function containsPersonalName(
  concept: string,
  profile: PmmBrandProfile
): boolean {
  const lowerConcept = concept.toLowerCase();
  return profile.publicName
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part.length >= 3)
    .some((part) => lowerConcept.includes(part));
}

function compositionInstruction(template: BrandTemplate): string {
  if (template.mode === "EDITORIAL_METAPHOR") {
    return "Confine the conceptual artwork to the designated right-side template image zone and preserve generous negative space for typography.";
  }
  return "Use restrained cropped abstract geometry within the designated template image zone and preserve generous negative space for typography.";
}

export function buildSourceArtPrompt(
  profile: PmmBrandProfile,
  template: BrandTemplate,
  conceptSummary: string
): SourceArtPrompt {
  const concept = normalizeConcept(conceptSummary);
  if (containsPersonalName(concept, profile)) {
    fail("identity_text");
  }

  const visualExpression = template.mode === "EDITORIAL_METAPHOR"
    ? "Express this concept through an abstract metaphor"
    : "Express this concept through restrained abstract geometry";
  const palette = [
    `warm ivory (${profile.palette.ivory})`,
    `ink navy (${profile.palette.navy})`,
    `muted copper (${profile.palette.copper})`,
    `soft taupe (${profile.palette.taupe})`
  ].join(", ");

  const generationPrompt = [
    "Create a restrained premium editorial visual for a Product Marketing field note.",
    `Use a ${palette} palette.`,
    "Compose for a 4:5 LinkedIn cover.",
    compositionInstruction(template),
    `${visualExpression}: ${concept}.`,
    "The visual should feel thoughtful, human, tactile, and magazine-like rather than literal or instructional.",
    "Do not include words, letters, numbers, names, logos, watermarks, UI, charts, lists, checklists, infographics, presentation slides, stock-photo poses, glossy 3D icons, generic AI gradients, or a literal depiction of every sentence in the post.",
    "Do not render any person's name or any cover-hook text.",
    "PMM Career MCP will add all typography and brand elements later."
  ].join(" ");

  return Object.freeze({
    formatVersion: 1,
    generationPrompt,
    negativeConstraints: NEGATIVE_CONSTRAINTS
  });
}
