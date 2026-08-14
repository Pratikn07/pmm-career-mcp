import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("does not retain the legacy text-only publishing implementation", async () => {
  const source = await readFile(new URL("../../src/linkedin/publish-service.ts", import.meta.url), "utf8");
  expect(source).not.toContain("createTextPost");
  expect(source).not.toContain("previewToken");
  expect(source).not.toContain("createPublishService");
  expect(source).toContain("ImagePublishService");
});
