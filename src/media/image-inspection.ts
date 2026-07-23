import { createHash } from "node:crypto";
import sharp from "sharp";
import { DomainError } from "../domain/errors.js";
import type { DraftMediaMimeType } from "./storage.js";

export type ImageInspection = Readonly<{
  mimeType: DraftMediaMimeType;
  width: number;
  height: number;
  frameCount: number;
  byteSize: number;
  sha256: string;
}>;

export const MAX_LINKEDIN_IMAGE_PIXELS_EXCLUSIVE = 36_152_320;
export const MAX_LINKEDIN_IMAGE_FRAMES = 250;
const MIME_BY_FORMAT: Readonly<Partial<Record<string, DraftMediaMimeType>>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif"
};

function mediaValidationError(): DomainError {
  return new DomainError("MEDIA_VALIDATION_ERROR", "Draft image validation failed");
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

export async function inspectLinkedInImage(
  bytes: Uint8Array,
  declaredMimeType?: string
): Promise<ImageInspection> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error("Image bytes are required");
    }
    const metadata = await sharp(bytes, {
      animated: true,
      failOn: "error",
      limitInputPixels: 36_152_319
    }).metadata();
    const mimeType = MIME_BY_FORMAT[metadata.format];
    if (mimeType === undefined || (declaredMimeType !== undefined && declaredMimeType !== mimeType)) {
      throw new Error("Image type rejected");
    }
    if (!positiveInteger(metadata.width) || !positiveInteger(metadata.height)) {
      throw new Error("Image dimensions rejected");
    }
    const decodedPixels = metadata.width * metadata.height;
    if (
      !Number.isSafeInteger(decodedPixels)
      || decodedPixels >= MAX_LINKEDIN_IMAGE_PIXELS_EXCLUSIVE
    ) {
      throw new Error("Image pixel count rejected");
    }

    const frameCount = metadata.pages ?? 1;
    if (!positiveInteger(frameCount) || frameCount > MAX_LINKEDIN_IMAGE_FRAMES) {
      throw new Error("Image frame count rejected");
    }
    const displayHeight = metadata.pageHeight ?? metadata.height;
    if (
      !positiveInteger(displayHeight)
      || displayHeight > metadata.height
      || (metadata.pageHeight !== undefined && displayHeight * frameCount !== metadata.height)
    ) {
      throw new Error("Image page dimensions rejected");
    }

    return {
      mimeType,
      width: metadata.width,
      height: displayHeight,
      frameCount,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch {
    throw mediaValidationError();
  }
}
