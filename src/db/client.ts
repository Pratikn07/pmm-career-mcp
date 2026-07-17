import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createRepositories } from "./repositories.js";
import { schema } from "./schema.js";

export type CareerDatabase = ReturnType<typeof createRepositories> & {
  close(): void;
};

export type TestCareerDatabase = CareerDatabase & {
  resetForTests(): void;
};

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

export function createDatabase(path: ":memory:"): TestCareerDatabase;
export function createDatabase(path: string): CareerDatabase;
export function createDatabase(path: string): CareerDatabase | TestCareerDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const database = drizzle(sqlite, { schema });
  migrate(database, { migrationsFolder: findMigrationsFolder() });
  const repositories = createRepositories(database);
  const careerDatabase: CareerDatabase = {
    ...repositories,
    close: () => sqlite.close()
  };

  if (path !== ":memory:") {
    return careerDatabase;
  }

  return {
    ...careerDatabase,
    resetForTests: () => {
      sqlite.exec(`
        DELETE FROM publish_attempts;
        DELETE FROM post_previews;
        DELETE FROM post_drafts;
        DELETE FROM shortlist_entries;
        DELETE FROM shortlists;
        DELETE FROM outreach_drafts;
        DELETE FROM target_notes;
        DELETE FROM targets;
        DELETE FROM evidence;
        DELETE FROM people;
        DELETE FROM companies;
        DELETE FROM oauth_tokens;
        DELETE FROM settings;
      `);
    }
  };
}
