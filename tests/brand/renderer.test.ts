import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { fontPath } from "../../src/brand/assets.js";
import {
  DEFAULT_PMM_BRAND_PROFILE,
  type PmmBrandProfile
} from "../../src/brand/profile.js";
import {
  buildCoverSvg,
  renderBrandedCover
} from "../../src/brand/renderer.js";
import {
  templateForMode,
  type BrandTemplate
} from "../../src/brand/templates.js";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithDimensions(
  source: Uint8Array,
  width: number,
  height: number
): Buffer {
  const bytes = Buffer.from(source);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

async function animatedGif(frameCount: number): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const height = pageHeight * frameCount;
  const pixels = Buffer.alloc(width * height * 4);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let pixel = 0; pixel < width * pageHeight; pixel += 1) {
      const offset = (frame * width * pageHeight + pixel) * 4;
      pixels[offset] = frame * 40;
      pixels[offset + 1] = frame * 80;
      pixels[offset + 2] = frame * 120;
      pixels[offset + 3] = 255;
    }
  }
  return await sharp(pixels, {
    raw: { width, height, channels: 4, pageHeight }
  }).gif({
    delay: Array.from({ length: frameCount }, () => 10),
    loop: 0
  }).toBuffer();
}

async function expectSourceValidationReason(
  sourceImageBytes: Buffer,
  reason: string
): Promise<void> {
  await expect(renderBrandedCover({
    profile: DEFAULT_PMM_BRAND_PROFILE,
    template: templateForMode("EDITORIAL_METAPHOR"),
    coverHook: "Clarity changes the frame.",
    sourceImageBytes
  })).rejects.toEqual(expect.objectContaining({
    code: "MEDIA_VALIDATION_ERROR",
    message: "Brand source image validation failed",
    details: { field: "sourceImageBytes", reason }
  }));
}

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

  it.each([
    "Solitude",
    "One two three four five six seven eight nine"
  ])("rejects hooks outside the exact two-to-eight-word tiers: %j", (coverHook) => {
    expect(() => buildCoverSvg({
      ...statementInput,
      coverHook
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "coverHook", reason: "word_count" }
    }));
  });

  it("accepts a topic label whose final Inter run fits the topic safe area", () => {
    expect(buildCoverSvg({
      ...statementInput,
      topicLabel: "GO-TO-MARKET"
    })).toContain(">GO-TO-MARKET</text>");
  });

  it("rejects a topic label whose final Inter run cannot fit", () => {
    expect(() => buildCoverSvg({
      ...statementInput,
      topicLabel: "W".repeat(24)
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "topicLabel", reason: "text_fit" }
    }));
  });

  it.each([
    ["coverHook", { coverHook: "Clarity\u0000 wins." }],
    ["topicLabel", { topicLabel: "POSITION\u0001ING" }]
  ])("rejects XML 1.0-invalid controls in %s", (field, override) => {
    expect(() => buildCoverSvg({
      ...statementInput,
      ...override
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field, reason: "xml_control" }
    }));
  });

  it("keeps caller text measurement caches local to one SVG build", async () => {
    const source = await readFile(
      new URL("../../src/brand/renderer.ts", import.meta.url),
      "utf8"
    );

    expect(source).not.toMatch(/^const measuredWidths = new Map/um);
    expect(source).toContain("function createTextMeasurer");
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

  it("snapshots canonical configuration and source bytes before an async boundary", async () => {
    const originalSource = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 185, g: 120, b: 80, alpha: 1 }
      }
    }).png().toBuffer();
    const callerSource = Buffer.from(originalSource);
    const callerProfile = structuredClone(
      DEFAULT_PMM_BRAND_PROFILE
    ) as PmmBrandProfile;
    const callerTemplate = structuredClone(
      templateForMode("EDITORIAL_METAPHOR")
    ) as BrandTemplate;

    const rendering = renderBrandedCover({
      profile: callerProfile,
      template: callerTemplate,
      coverHook: "Clarity changes the frame.",
      sourceImageBytes: callerSource
    });
    queueMicrotask(() => {
      (callerProfile.palette as { ivory: string }).ivory = "#000000";
      (callerTemplate.imageZone as { x: number }).x = 0;
      callerSource.fill(0);
    });

    const [actual, expected] = await Promise.all([
      rendering,
      renderBrandedCover({
        profile: DEFAULT_PMM_BRAND_PROFILE,
        template: templateForMode("EDITORIAL_METAPHOR"),
        coverHook: "Clarity changes the frame.",
        sourceImageBytes: originalSource
      })
    ]);

    expect(actual.bytes).toEqual(expected.bytes);
    expect(actual.validation.sourceImageUsed).toBe(true);
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

  it("rejects encoded source bytes above 20 MiB before decoding", async () => {
    const oversized = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      .copy(oversized);

    await expectSourceValidationReason(oversized, "byte_size");
  });

  it("rejects malformed raster signatures before decoding", async () => {
    await expectSourceValidationReason(
      Buffer.from("private malformed image body"),
      "signature"
    );
  });

  it("rejects source dimensions above 8192 pixels per axis", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: "#14233A"
      }
    }).png().toBuffer();

    await expectSourceValidationReason(
      pngWithDimensions(png, 8193, 1025),
      "dimensions"
    );
  });

  it("rejects source images above the decoded pixel limit", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: "#14233A"
      }
    }).png().toBuffer();

    await expectSourceValidationReason(
      pngWithDimensions(png, 7000, 5200),
      "pixel_count"
    );
  });

  it("rejects source images with an aspect ratio above 8 to 1", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: "#14233A"
      }
    }).png().toBuffer();

    await expectSourceValidationReason(
      pngWithDimensions(png, 8192, 1000),
      "aspect_ratio"
    );
  });

  it("rejects animated or multipage source images", async () => {
    await expectSourceValidationReason(await animatedGif(2), "frame_count");
  });
});
