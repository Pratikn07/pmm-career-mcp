import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("pins JSZip as a production dependency", async () => {
  const packageSource = await readFile(resolve(process.cwd(), "package.json"), "utf8");
  const packageJson = JSON.parse(packageSource) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  expect(packageJson.dependencies?.jszip).toBe("3.10.1");
  expect(packageJson.devDependencies?.jszip).toBeUndefined();
  expect(packageJson.dependencies?.exceljs).toBeUndefined();
});

it("locks the MCP runtime onto reviewed patched transitive dependencies", async () => {
  const [packageSource, lockSource, dockerfile] = await Promise.all([
    readFile(resolve(process.cwd(), "package.json"), "utf8"),
    readFile(resolve(process.cwd(), "package-lock.json"), "utf8"),
    readFile(resolve(process.cwd(), "Dockerfile"), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const packageLock = JSON.parse(lockSource) as {
    packages?: Record<string, { version?: string }>;
  };

  expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.29.0");
  expect(packageJson.overrides).toEqual({
    "@hono/node-server": "2.0.11",
    "fast-uri": "3.1.4"
  });
  expect(packageLock.packages?.["node_modules/@hono/node-server"]?.version).toBe("2.0.11");
  expect(packageLock.packages?.["node_modules/fast-uri"]?.version).toBe("3.1.4");
  expect(dockerfile.match(/^FROM node:22-bookworm-slim/gmu)).toHaveLength(2);
});
