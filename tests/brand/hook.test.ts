import { describe, expect, it } from "vitest";
import { validateCoverHook, normalizeTopicLabel } from "../../src/brand/hook.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "../../src/brand/profile.js";
import { templateForMode } from "../../src/brand/templates.js";

describe("validateCoverHook", () => {
  it("returns a normalized hook that follows the brand rules", () => {
    expect(validateCoverHook(
      "Teams often mistake more features for more value.",
      "Clarity beats capability."
    )).toBe("Clarity beats capability.");
  });

  it("rejects a complete sentence copied from the post", () => {
    expect(() => validateCoverHook(
      "Clarity beats capability.",
      "Clarity beats capability."
    )).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "coverHook", reason: "post_duplicate" }
    }));
  });

  it("rejects hooks longer than eight words", () => {
    expect(() => validateCoverHook(
      "Post",
      "One two three four five six seven eight nine"
    )).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "coverHook", reason: "word_count" }
    }));
  });

  it.each([
    "You won't believe this",
    "Read this now",
    "Here's the secret today"
  ])("rejects the generic engagement bait phrase in %j", (hook) => {
    expect(() => validateCoverHook("Post", hook))
      .toThrowError(expect.objectContaining({
        code: "VALIDATION_ERROR",
        details: { field: "coverHook", reason: "engagement_bait" }
      }));
  });

  it.each([
    ["a caller-supplied newline", "Clarity\nbeats capability", "single_line"],
    ["a caller-supplied vertical tab", "Clarity\vbeats capability", "single_line"],
    ["a caller-supplied form feed", "Clarity\fbeats capability", "single_line"],
    ["a URL", "Visit https://example.com today", "url"],
    ["a bare domain with a modern TLD", "Visit example.xyz today", "url"],
    ["a hashtag", "Clarity beats #capability", "hashtag"],
    ["a leading bullet", "• Clarity beats capability", "list_marker"],
    ["a leading small-square bullet", "▪ Clarity beats capability", "list_marker"],
    ["a digit claim", "Clarity wins 3 times", "numeric_claim"],
    ["an emoji run", "Clarity 👀 🚀 ✨ wins", "emoji_count"]
  ])("rejects %s", (_label, hook, reason) => {
    expect(() => validateCoverHook("A separate post.", hook))
      .toThrowError(expect.objectContaining({
        code: "VALIDATION_ERROR",
        details: { field: "coverHook", reason }
      }));
  });

  it("counts Unicode characters by code point after NFC normalization", () => {
    const hook = `Think ${"界".repeat(66)}`;
    expect(validateCoverHook("A separate post.", hook)).toBe(hook);

    expect(() => validateCoverHook("A separate post.", `${hook}界`))
      .toThrowError(expect.objectContaining({
        details: { field: "coverHook", reason: "character_count" }
      }));
  });

  it("rejects a duplicate separated by a Unicode line separator", () => {
    expect(() => validateCoverHook(
      "A different opening\u2028Clarity beats capability.",
      "Clarity beats capability."
    )).toThrowError(expect.objectContaining({
      details: { field: "coverHook", reason: "post_duplicate" }
    }));
  });

  it("does not mistake ordinary sentence punctuation for a bare domain", () => {
    expect(validateCoverHook(
      "A separate post.",
      "More features. Less meaning."
    )).toBe("More features. Less meaning.");
  });
});

describe("normalizeTopicLabel", () => {
  it("normalizes a topic label to uppercase NFC with collapsed whitespace", () => {
    expect(normalizeTopicLabel(" Positioning ")).toBe("POSITIONING");
    expect(normalizeTopicLabel("  go-to-market   motion ")).toBe("GO-TO-MARKET MOTION");
  });
});

describe("the immutable brand registry", () => {
  it("defines the exact PMM Field Notes identity and deeply frozen profile", () => {
    expect(DEFAULT_PMM_BRAND_PROFILE).toMatchObject({
      version: 1,
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      palette: {
        ivory: "#F6F1E8",
        navy: "#14233A",
        copper: "#B97850",
        taupe: "#C9B8A5",
        highlight: "#FFFDF9"
      }
    });
    expect(Object.isFrozen(DEFAULT_PMM_BRAND_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PMM_BRAND_PROFILE.voice)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PMM_BRAND_PROFILE.voice.traits)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PMM_BRAND_PROFILE.palette)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PMM_BRAND_PROFILE.hookRules)).toBe(true);
  });

  it("selects immutable statement and metaphor templates", () => {
    const statement = templateForMode("EDITORIAL_STATEMENT");
    const metaphor = templateForMode("EDITORIAL_METAPHOR");

    expect(statement).toMatchObject({
      id: "editorial-statement-v1",
      version: 1,
      width: 1080,
      height: 1350,
      requiresSourceImage: false
    });
    expect(metaphor).toMatchObject({
      id: "editorial-metaphor-v1",
      version: 1,
      width: 1080,
      height: 1350,
      requiresSourceImage: true
    });
    expect(Object.isFrozen(statement)).toBe(true);
    expect(Object.isFrozen(statement.safeTextRectangles)).toBe(true);
    expect(Object.isFrozen(metaphor.imageZone)).toBe(true);
  });

  it("keeps every text-safe rectangle in bounds and outside each image zone", () => {
    const templates = [
      templateForMode("EDITORIAL_STATEMENT"),
      templateForMode("EDITORIAL_METAPHOR")
    ];

    for (const template of templates) {
      for (const rectangle of Object.values(template.safeTextRectangles)) {
        expect(rectangle.x).toBeGreaterThanOrEqual(0);
        expect(rectangle.y).toBeGreaterThanOrEqual(0);
        expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(template.width);
        expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(template.height);

        const overlapsImageZone =
          rectangle.x < template.imageZone.x + template.imageZone.width &&
          rectangle.x + rectangle.width > template.imageZone.x &&
          rectangle.y < template.imageZone.y + template.imageZone.height &&
          rectangle.y + rectangle.height > template.imageZone.y;
        expect(overlapsImageZone).toBe(false);
      }
    }
  });
});
