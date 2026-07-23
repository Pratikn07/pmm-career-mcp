import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND_ASSET_NAMES = new Set([
  "CormorantGaramond-SemiBold.ttf",
  "CormorantGaramond-SemiBoldItalic.ttf",
  "Inter-Medium.ttf",
  "Inter-SemiBold.ttf",
  "OFL-Cormorant.txt",
  "LICENSE-Inter.txt"
] as const);

export type BrandAssetName =
  | "CormorantGaramond-SemiBold.ttf"
  | "CormorantGaramond-SemiBoldItalic.ttf"
  | "Inter-Medium.ttf"
  | "Inter-SemiBold.ttf"
  | "OFL-Cormorant.txt"
  | "LICENSE-Inter.txt";

let cachedFontsDirectory: string | undefined;

function findFontsDirectory(): string {
  if (cachedFontsDirectory !== undefined) {
    return cachedFontsDirectory;
  }

  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const fontsDirectory = resolve(directory, "assets", "fonts");
    if (
      existsSync(resolve(directory, "package.json"))
      && existsSync(fontsDirectory)
    ) {
      cachedFontsDirectory = fontsDirectory;
      return fontsDirectory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Unable to locate the packaged brand font assets");
    }
    directory = parent;
  }
}

export function fontPath(name: BrandAssetName): string {
  if (!BRAND_ASSET_NAMES.has(name)) {
    throw new Error("Unknown bundled brand asset");
  }

  const path = resolve(findFontsDirectory(), name);
  if (!existsSync(path)) {
    throw new Error("Bundled brand asset is missing");
  }
  return path;
}
