import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("copies the consent build script before building the Docker image", async () => {
  const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");
  const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
  const build = dockerfile.indexOf("RUN npm run build");

  expect(scriptsCopy).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(scriptsCopy);
});
