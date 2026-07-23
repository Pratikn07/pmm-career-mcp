import { describe, expect, it } from "vitest";
import { buildSourceArtPrompt } from "../../src/brand/prompt.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "../../src/brand/profile.js";
import { templateForMode } from "../../src/brand/templates.js";

describe("buildSourceArtPrompt", () => {
  it("builds the canonical text-free metaphor prompt without personal identity", () => {
    const prompt = buildSourceArtPrompt(
      DEFAULT_PMM_BRAND_PROFILE,
      templateForMode("EDITORIAL_METAPHOR"),
      "An open doorway whose destination is intentionally ambiguous"
    );

    expect(prompt.formatVersion).toBe(1);
    expect(prompt.generationPrompt).toContain("warm ivory");
    expect(prompt.generationPrompt).toContain("ink navy");
    expect(prompt.generationPrompt).toContain("muted copper");
    expect(prompt.generationPrompt).toContain("soft taupe");
    expect(prompt.generationPrompt).toContain("open doorway");
    expect(prompt.generationPrompt).not.toContain("Bhagyashree");
    expect(prompt.negativeConstraints).toContain("readable text");
    expect(prompt.negativeConstraints).toContain("names, logos, or watermarks");
    expect(prompt.negativeConstraints).toContain(
      "UI, charts, lists, checklists, infographics, or presentation slides"
    );
  });

  it("removes line controls and returns deeply immutable deterministic output", () => {
    const template = templateForMode("EDITORIAL_STATEMENT");
    const first = buildSourceArtPrompt(
      DEFAULT_PMM_BRAND_PROFILE,
      template,
      "Tension between focus\nand too many choices\u2028shown abstractly"
    );
    const second = buildSourceArtPrompt(
      DEFAULT_PMM_BRAND_PROFILE,
      template,
      "Tension between focus and too many choices shown abstractly"
    );

    expect(first).toEqual(second);
    expect(first.generationPrompt).not.toMatch(/[\r\n\u0085\u2028\u2029]/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.negativeConstraints)).toBe(true);
  });

  it("rejects empty, oversized, and identity-bearing concepts safely", () => {
    const template = templateForMode("EDITORIAL_METAPHOR");
    const invalid = [
      [" \n ", "character_count"],
      ["界".repeat(501), "character_count"],
      ["A portrait of Bhagyashree Nandoskar thinking", "identity_text"]
    ] as const;

    for (const [concept, reason] of invalid) {
      expect(() => buildSourceArtPrompt(
        DEFAULT_PMM_BRAND_PROFILE,
        template,
        concept
      )).toThrowError(expect.objectContaining({
        code: "VALIDATION_ERROR",
        details: { field: "conceptSummary", reason }
      }));
    }
  });
});
