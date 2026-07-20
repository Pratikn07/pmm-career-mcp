import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  inspectLinkedInImage,
  type ImageInspection
} from "../../src/media/image-inspection.js";

const MAX_PIXELS = 36_152_319;

let jpeg: Buffer;
let png: Buffer;
let gif: Buffer;
let webp: Buffer;
let gif250: Buffer;
let gif251: Buffer;

async function animatedGif(frameCount: number): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const height = pageHeight * frameCount;
  const pixels = Buffer.alloc(width * height * 4);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let pixel = 0; pixel < width * pageHeight; pixel += 1) {
      const offset = (frame * width * pageHeight + pixel) * 4;
      pixels[offset] = frame % 256;
      pixels[offset + 1] = (frame * 3) % 256;
      pixels[offset + 2] = (frame * 7) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return await sharp(pixels, {
    raw: { width, height, channels: 4, pageHeight }
  }).gif({ delay: Array.from({ length: frameCount }, () => 10), loop: 0 }).toBuffer();
}

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

function pngWithDimensions(source: Uint8Array, width: number, height: number): Buffer {
  const bytes = Buffer.from(source);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

function expectedInspection(
  bytes: Uint8Array,
  mimeType: ImageInspection["mimeType"],
  width: number,
  height: number,
  frameCount = 1
): ImageInspection {
  return {
    mimeType,
    width,
    height,
    frameCount,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function expectSafeValidationError(
  action: () => Promise<unknown>,
  forbiddenValues: readonly string[] = []
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe("MEDIA_VALIDATION_ERROR");
    expect(domainError.message).toBe("Draft image validation failed");
    expect(domainError.details).toEqual({});
    expect(Object.hasOwn(domainError, "cause")).toBe(false);
    const visibleError = `${domainError.message}\n${domainError.stack ?? ""}\n${JSON.stringify(domainError)}`;
    for (const value of forbiddenValues) {
      expect(visibleError).not.toContain(value);
    }
    return domainError;
  }
  throw new Error("Expected a DomainError");
}

beforeAll(async () => {
  const create = {
    width: 3,
    height: 2,
    channels: 4 as const,
    background: { r: 20, g: 80, b: 160, alpha: 1 }
  };
  jpeg = await sharp({ create }).jpeg().toBuffer();
  png = await sharp({ create }).png().toBuffer();
  webp = await sharp({ create }).webp().toBuffer();
  gif = await animatedGif(3);
  gif250 = await animatedGif(250);
  gif251 = await animatedGif(251);
});

describe("inspectLinkedInImage", () => {
  it("reports exact metadata and hashes the unchanged original JPEG, PNG, and animated GIF bytes", async () => {
    const fixtures = [
      { bytes: jpeg, mimeType: "image/jpeg" as const, width: 3, height: 2, frames: 1 },
      { bytes: png, mimeType: "image/png" as const, width: 3, height: 2, frames: 1 },
      { bytes: gif, mimeType: "image/gif" as const, width: 2, height: 2, frames: 3 }
    ];

    for (const fixture of fixtures) {
      const before = Buffer.from(fixture.bytes);
      await expect(inspectLinkedInImage(fixture.bytes, fixture.mimeType)).resolves.toEqual(
        expectedInspection(
          fixture.bytes,
          fixture.mimeType,
          fixture.width,
          fixture.height,
          fixture.frames
        )
      );
      expect(fixture.bytes).toEqual(before);
    }
  });

  it.each([
    "image/jpeg",
    "image/gif",
    "Image/PNG",
    "image/png; charset=binary",
    "application/octet-stream",
    "private-provider-mime-value"
  ])("rejects a declared MIME mismatch exactly: %s", async (declaredMimeType) => {
    await expectSafeValidationError(
      () => inspectLinkedInImage(png, declaredMimeType),
      [declaredMimeType]
    );
  });

  it("accepts an omitted declared MIME type", async () => {
    await expect(inspectLinkedInImage(png)).resolves.toEqual(
      expectedInspection(png, "image/png", 3, 2)
    );
  });

  it("rejects malformed bytes without exposing their contents or Sharp's cause", async () => {
    const providerSecret = "private-provider-image-body";
    const malformed = Buffer.from(providerSecret);

    await expectSafeValidationError(
      () => inspectLinkedInImage(malformed, "image/png"),
      [providerSecret]
    );
  });

  it("allows only exact JPEG, PNG, and GIF formats", async () => {
    await expectSafeValidationError(() => inspectLinkedInImage(webp, "image/webp"));
  });

  it("rejects zero and oversized dimensions", async () => {
    await expectSafeValidationError(() => inspectLinkedInImage(
      pngWithDimensions(png, 0, 1),
      "image/png"
    ));
    await expectSafeValidationError(() => inspectLinkedInImage(
      pngWithDimensions(png, 6_000, 6_026),
      "image/png"
    ));
  });

  it("accepts 36,152,319 decoded pixels and rejects the next representable boundary", async () => {
    const atLimit = pngWithDimensions(png, 357, 101_267);
    const overLimit = pngWithDimensions(png, 357, 101_268);

    await expect(inspectLinkedInImage(atLimit, "image/png")).resolves.toEqual(
      expectedInspection(atLimit, "image/png", 357, 101_267)
    );
    expect(357 * 101_267).toBe(MAX_PIXELS);
    await expectSafeValidationError(() => inspectLinkedInImage(overLimit, "image/png"));
  });

  it("accepts a 250-frame GIF and rejects frame 251", async () => {
    await expect(inspectLinkedInImage(gif250, "image/gif")).resolves.toEqual(
      expectedInspection(gif250, "image/gif", 2, 2, 250)
    );
    await expectSafeValidationError(() => inspectLinkedInImage(gif251, "image/gif"));
  });
});
