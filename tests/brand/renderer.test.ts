import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { fontPath } from "../../src/brand/assets.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "../../src/brand/profile.js";
import {
  buildCoverSvg,
  renderBrandedCover
} from "../../src/brand/renderer.js";
import { templateForMode } from "../../src/brand/templates.js";

const FONT_CHECKSUMS = {
  "CormorantGaramond-SemiBold.ttf":
    "dc4bc094dc3c55cf79ff2f6f0ba1e501b712fc3cf3742296cd8fdcc6e995127d",
  "CormorantGaramond-SemiBoldItalic.ttf":
    "d9b23c3f2109428aa293cc9bfdba2a9d1c96392a1182227a40c7a24967b1211c",
  "Inter-Medium.ttf":
    "97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872",
  "Inter-SemiBold.ttf":
    "78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3",
  "OFL-Cormorant.txt":
    "60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956",
  "LICENSE-Inter.txt":
    "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a"
} as const;

const statementInput = {
  profile: DEFAULT_PMM_BRAND_PROFILE,
  template: templateForMode("EDITORIAL_STATEMENT"),
  coverHook: "Clarity beats capability.",
  topicLabel: "POSITIONING"
} as const;

describe("bundled renderer assets", () => {
  it("pins every production font and license to its reviewed upstream bytes", async () => {
    for (const [name, checksum] of Object.entries(FONT_CHECKSUMS)) {
      const bytes = await readFile(fontPath(name as keyof typeof FONT_CHECKSUMS));
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(checksum);
    }
  });
});

describe("buildCoverSvg", () => {
  it("normalizes and XML-escapes every caller-controlled string", () => {
    const callerMarkup = `A <svg/> & "quoted" 'mark'`;
    const svg = buildCoverSvg({
      ...statementInput,
      coverHook: `  A   <svg/> & "quoted" 'mark'  `,
      topicLabel: `R&D <tag "x">`
    });

    expect(svg).toContain(`A &lt;svg/&gt; &amp;`);
    expect(svg).toContain(`&quot;quoted&quot; &apos;mark&apos;`);
    expect(svg).toContain(`R&amp;D &lt;tag &quot;x&quot;&gt;`);
    expect(svg).not.toContain(callerMarkup);
    expect(svg).not.toContain("<svg/>");
    expect(svg).not.toContain("<tag");
    expect(svg).not.toMatch(/<script|onload\s*=|href\s*=/iu);
  });

  it.each([
    ["Two clear words", "2-4"],
    ["Five clear words fit here", "5-6"],
    ["Seven clear words can still fit here", "7-8"]
  ])("uses the fixed word-count layout for %j", (coverHook, tier) => {
    const svg = buildCoverSvg({ ...statementInput, coverHook });

    expect(svg).toContain(`data-hook-tier="${tier}"`);
    expect(svg.match(/data-hook-line="/gu)?.length).toBeLessThanOrEqual(2);
    expect(svg.match(/data-hook-line="/gu)?.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a valid-length hook when no safe two-line layout exists", () => {
    expect(() => buildCoverSvg({
      profile: DEFAULT_PMM_BRAND_PROFILE,
      template: templateForMode("EDITORIAL_METAPHOR"),
      coverHook:
        "Pneumonoultramicroscopicsilicovolcanoconiosis counterdemonstrations"
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "coverHook", reason: "text_fit" }
    }));
  });

  it("is byte-for-byte deterministic for identical inputs", () => {
    expect(buildCoverSvg(statementInput)).toBe(buildCoverSvg(statementInput));
  });
});

describe("renderBrandedCover", () => {
  it("renders exactly one validated 1080 by 1350 PNG", async () => {
    const result = await renderBrandedCover(statementInput);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1350);
    expect(result.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(result.bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(metadata).toMatchObject({
      format: "png",
      width: 1080,
      height: 1350
    });
    expect(result.validation).toEqual({
      fixedLabelsPresent: true,
      textWithinSafeArea: true,
      sourceImageUsed: false
    });
  }, 30_000);

  it("renders byte-identical PNGs for identical inputs", async () => {
    const [first, second] = await Promise.all([
      renderBrandedCover(statementInput),
      renderBrandedCover(statementInput)
    ]);

    expect(first.bytes).toEqual(second.bytes);
  }, 30_000);

  it("requires and composites source art only for the metaphor template", async () => {
    const template = templateForMode("EDITORIAL_METAPHOR");
    const input = {
      profile: DEFAULT_PMM_BRAND_PROFILE,
      template,
      coverHook: "Clarity changes the frame."
    } as const;

    await expect(renderBrandedCover(input)).rejects.toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "sourceImageBytes", reason: "required" }
    }));

    const sourceImageBytes = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 185, g: 120, b: 80, alpha: 1 }
      }
    }).png().toBuffer();
    const result = await renderBrandedCover({ ...input, sourceImageBytes });

    expect(result.validation.sourceImageUsed).toBe(true);
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      format: "png",
      width: 1080,
      height: 1350
    });
  }, 30_000);

  it("rejects source art for the statement template", async () => {
    const sourceImageBytes = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 20, g: 30, b: 40, alpha: 1 }
      }
    }).png().toBuffer();

    await expect(renderBrandedCover({
      ...statementInput,
      sourceImageBytes
    })).rejects.toEqual(expect.objectContaining<Partial<DomainError>>({
      code: "VALIDATION_ERROR",
      details: { field: "sourceImageBytes", reason: "not_allowed" }
    }));
  });

  it("rejects caller-provided SVG as source art", async () => {
    const sourceImageBytes = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>`
    );

    await expect(renderBrandedCover({
      profile: DEFAULT_PMM_BRAND_PROFILE,
      template: templateForMode("EDITORIAL_METAPHOR"),
      coverHook: "Clarity changes the frame.",
      sourceImageBytes
    })).rejects.toEqual(expect.objectContaining({
      code: "MEDIA_VALIDATION_ERROR",
      message: "Brand source image validation failed"
    }));
  });
});
