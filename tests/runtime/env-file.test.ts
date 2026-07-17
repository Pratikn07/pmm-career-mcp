import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads an optional local .env file for both development and production start scripts", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(manifest.scripts.dev).toContain("--env-file-if-exists=.env");
  expect(manifest.scripts.start).toContain("--env-file-if-exists=.env");

  const fixture = resolve(process.cwd(), "tests/fixtures/env-file.env");
  const loaded = spawnSync(process.execPath, [
    `--env-file=${fixture}`,
    "-e",
    "process.stdout.write(process.env.CAREER_MCP_ENV_FILE_TEST ?? '')"
  ], { encoding: "utf8" });
  expect(loaded.status).toBe(0);
  expect(loaded.stdout).toBe("loaded-from-local-env-file");
});
