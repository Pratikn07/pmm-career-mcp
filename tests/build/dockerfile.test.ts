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
  expect(dockerfile).toContain("process.env.PORT || 3000");
  expect(dockerfile).not.toContain("http://127.0.0.1:3000/ready");
  expect(dockerfile).not.toContain("/app/data");
  expect(dockerfile).not.toContain("DATABASE_PATH");
});

it("documents Supabase operations without legacy SQLite backup instructions", async () => {
  const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");

  expect(readme).toContain("The Docker health check calls `/ready`");
  expect(readme).toContain("Supabase managed backups");
  expect(readme).not.toMatch(/SQLite|DATABASE_PATH/i);
});

it("provides a no-secret Supabase, Railway, and ChatGPT operator runbook", async () => {
  const [environmentExample, readme, runbook] = await Promise.all([
    readFile(resolve(process.cwd(), ".env.example"), "utf8"),
    readFile(resolve(process.cwd(), "README.md"), "utf8"),
    readFile(resolve(process.cwd(), "docs/deployment/supabase-railway-chatgpt.md"), "utf8")
  ]);

  expect(environmentExample).not.toContain("DATABASE_PATH");
  expect(environmentExample).toContain("DATABASE_URL=");
  expect(environmentExample).toContain("SUPABASE_URL=");
  expect(environmentExample).toContain("SUPABASE_PUBLISHABLE_KEY=");
  expect(environmentExample).toContain("BASE_URL=");
  expect(environmentExample).toContain("NODE_ENV=development");
  expect(environmentExample).toContain("BASE_URL=http://127.0.0.1:3000");
  expect(environmentExample).toContain("AUTH_MODE=none");
  expect(environmentExample).toContain("postgresql://postgres:postgres@127.0.0.1:5432/postgres");
  expect(environmentExample).toContain("local PostgreSQL");
  expect(environmentExample).toContain("# AUTH_MODE=oauth");
  expect(environmentExample).toContain("LINKEDIN_PUBLISH_ENABLED=false");
  expect(environmentExample).toMatch(/OIDC_ISSUER=.*\/auth\/v1/);
  expect(environmentExample).toContain("OIDC_AUDIENCE=https://<railway-service-domain>");
  expect(environmentExample).toContain("career_mcp_runtime.<project-ref>");
  expect(environmentExample).toContain("postgres.<project-ref>");
  expect(environmentExample).toContain("aws-<region>.pooler.supabase.com");
  expect(environmentExample).toMatch(/percent-encode/i);
  expect(readme).toMatch(/change both `DATABASE_URL` and `MIGRATION_DATABASE_URL`/i);
  expect(readme).toMatch(/production[\s\S]*`DATABASE_URL`[\s\S]*`MIGRATION_DATABASE_URL`/i);
  expect(runbook).toContain("Data API");
  expect(runbook).toContain("`anon` or `authenticated`");
  expect(runbook).toContain("asymmetric JWT");
  expect(runbook).toContain("disable open signups");
  expect(runbook).toContain("Site URL");
  expect(runbook).toContain("Dynamic Client Registration");
  expect(runbook).toContain("npm run smoke:supabase");
  expect(runbook).toMatch(/Dashboard[^\n]*Connect/i);
  expect(runbook).toMatch(/Session Pooler/i);
  expect(runbook).toMatch(/percent-encode/i);
  expect(runbook).toMatch(/`MIGRATION_DATABASE_URL`[^\n]*migrat/i);
  expect(runbook).toMatch(/`DATABASE_URL`[^\n]*(?:read|write|DML|runtime)/i);
  expect(runbook).toMatch(/run `supabase\/runtime-role\.sql`[^\n]*before[^\n]*(?:smoke|deploy|migration)/i);
  expect(runbook).toMatch(/CREATE SCHEMA IF NOT EXISTS/i);
  expect(runbook).toMatch(/default privileges[^\n]*migrations/i);
  expect(runbook).toContain("/oauth/consent");
  expect(runbook).toContain("/health");
  expect(runbook).toContain("/ready");
  expect(runbook).toContain("/mcp");
  expect(runbook).toContain("beta");
  expect(runbook).toContain("wrong `aud` claim");
  expect(runbook).toContain("GitHub App access to only this repository");
  expect(runbook).toContain("LINKEDIN_PUBLISH_ENABLED=false");
  expect(runbook).toContain("`LINKEDIN_REDIRECT_URI`");
  expect(runbook).toContain("Leave `LINKEDIN_REDIRECT_URI` unset");
  expect(runbook).toContain("`BASE_URL` is public configuration");
  expect(runbook).toContain("only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`");
  expect(readme).toContain("docs/deployment/supabase-railway-chatgpt.md");
  expect(`${environmentExample}\n${readme}\n${runbook}`).not.toMatch(/DATABASE_PATH|SQLite|persistent volume|Railway volume/i);
});
