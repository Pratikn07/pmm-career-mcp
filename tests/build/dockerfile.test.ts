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

it("ships Postgres migrations and uses the readiness endpoint for Docker deployment health", async () => {
  const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");

  expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/drizzle ./drizzle");
  expect(dockerfile).toContain("USER node");
  expect(dockerfile).toContain("http://127.0.0.1:3000/ready");
  expect(dockerfile).not.toContain("/app/data");
  expect(dockerfile).not.toContain("DATABASE_PATH");
});

it("documents Supabase operations without legacy SQLite backup instructions", async () => {
  const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");

  expect(readme).toContain("The Docker health check calls `/ready`");
  expect(readme).toContain("Supabase managed backups");
  expect(readme).not.toMatch(/SQLite|DATABASE_PATH/i);
});
