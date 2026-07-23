import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { CareerDatabase } from "../../src/db/client.js";
import { createRepositories } from "../../src/db/repositories.js";
import { schema } from "../../src/db/schema.js";

export type TestCareerDatabase = CareerDatabase & {
  resetForTests(): Promise<void>;
};

export type TestQueryLogEntry = {
  query: string;
  params: unknown[];
};

const clients = new WeakMap<TestCareerDatabase, PGlite>();

function findMigrationsFolder(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const migrationsFolder = resolve(directory, "drizzle");
    if (
      existsSync(resolve(directory, "package.json"))
      && existsSync(resolve(migrationsFolder, "meta", "_journal.json"))
    ) {
      return migrationsFolder;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Unable to locate the packaged Drizzle migrations directory");
    }
    directory = parent;
  }
}

export async function createTestDatabase(options: {
  queryLog?: TestQueryLogEntry[];
} = {}): Promise<TestCareerDatabase> {
  const client = new PGlite();
  const database = drizzle(client, {
    schema,
    ...(options.queryLog === undefined
      ? {}
      : {
          logger: {
            logQuery(query: string, params: unknown[]) {
              options.queryLog?.push({ query, params });
            }
          }
        })
  });

  try {
    await migrate(database, { migrationsFolder: findMigrationsFolder() });
  } catch (error) {
    await client.close();
    throw error;
  }

  const repositories = createRepositories(database);
  const careerDatabase: TestCareerDatabase = {
    ...repositories,
    checkReady: async () => {
      await client.query("select 1");
    },
    close: async () => {
      clients.delete(careerDatabase);
      await client.close();
    },
    resetForTests: async () => {
      await client.exec(`
        truncate table
          career_mcp.publish_attempt_media,
          career_mcp.publish_attempts,
          career_mcp.post_previews,
          career_mcp.post_draft_media,
          career_mcp.brand_visual_renders,
          career_mcp.media_usage_claims,
          career_mcp.brand_visual_briefs,
          career_mcp.brand_profiles,
          career_mcp.post_media,
          career_mcp.post_drafts,
          career_mcp.shortlist_entries,
          career_mcp.shortlists,
          career_mcp.outreach_drafts,
          career_mcp.target_notes,
          career_mcp.targets,
          career_mcp.evidence,
          career_mcp.people,
          career_mcp.companies,
          career_mcp.oauth_tokens,
          career_mcp.settings
        cascade
      `);
    }
  };
  clients.set(careerDatabase, client);
  return careerDatabase;
}

export async function queryTestDatabase<T extends Record<string, unknown>>(
  database: TestCareerDatabase,
  query: string
): Promise<T[]> {
  const client = clients.get(database);
  if (client === undefined) {
    throw new Error("Test database is closed or was not created by createTestDatabase");
  }
  const result = await client.query<T>(query);
  return result.rows;
}
