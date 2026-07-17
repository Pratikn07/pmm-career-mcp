import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createRepositories } from "./repositories.js";
import { schema } from "./schema.js";

export type CareerDatabase = ReturnType<typeof createRepositories> & {
  checkReady(): Promise<void>;
  close(): Promise<void>;
};

export type DatabaseConnectionOptions = {
  requireTls: boolean;
};

function validateDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }
}

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

export async function createDatabase(
  databaseUrl: string,
  options: DatabaseConnectionOptions
): Promise<CareerDatabase> {
  validateDatabaseUrl(databaseUrl);
  const client = postgres(databaseUrl, {
    max: 5,
    ...(options.requireTls ? { ssl: "require" } : {})
  });
  const database = drizzle(client, { schema });

  try {
    await migrate(database, { migrationsFolder: findMigrationsFolder() });
  } catch (error) {
    await client.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }

  const repositories = createRepositories(database);
  return {
    ...repositories,
    checkReady: async () => {
      await client`select 1`;
    },
    close: async () => {
      await client.end({ timeout: 5 });
    }
  };
}
