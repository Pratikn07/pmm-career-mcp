import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outputFile = resolve("dist/public/consent-client.js");
await mkdir(dirname(outputFile), { recursive: true });
await build({
  entryPoints: [resolve("src/oauth/consent-client.ts")],
  outfile: outputFile,
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none"
});
