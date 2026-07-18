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
  migrationDatabaseUrl?: string;
  requireTls: boolean;
};

type DatabaseClientPurpose = "migration" | "runtime";

const CONNECTION_TIMEOUT_SECONDS = 10;
const IDLE_TIMEOUT_SECONDS = 30;
const SESSION_TIMEOUT_MILLISECONDS = 30_000;

function validateDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }
  return parsed;
}

function connectionOptions(
  databaseUrl: URL,
  purpose: DatabaseClientPurpose,
  requireTls: boolean
) {
  return {
    max: purpose === "migration" ? 1 : 5,
    connect_timeout: CONNECTION_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connection: {
      application_name: `pmm-career-mcp-${purpose}`,
      statement_timeout: SESSION_TIMEOUT_MILLISECONDS,
      idle_in_transaction_session_timeout: SESSION_TIMEOUT_MILLISECONDS
    },
    ...(requireTls
      ? { ssl: { rejectUnauthorized: true, servername: databaseUrl.hostname } }
      : {})
  };
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
  const runtimeUrl = validateDatabaseUrl(databaseUrl);
  const migrationDatabaseUrl = options.migrationDatabaseUrl ?? databaseUrl;
  const migrationUrl = validateDatabaseUrl(migrationDatabaseUrl);
  const migrationClient = postgres(
    migrationDatabaseUrl,
    connectionOptions(migrationUrl, "migration", options.requireTls)
  );
  let runtimeClient: ReturnType<typeof postgres> | undefined;
  let migrationClosed = false;

  const closeMigration = async (): Promise<void> => {
    if (migrationClosed) return;
    migrationClosed = true;
    await migrationClient.end({ timeout: 5 });
  };

  try {
    runtimeClient = postgres(
      databaseUrl,
      connectionOptions(runtimeUrl, "runtime", options.requireTls)
    );
    await migrationClient.begin(async (transactionClient) => {
      await transactionClient`select pg_advisory_xact_lock(hashtext('pmm-career-mcp:migrations'))`;
      // Drizzle expects a full postgres.js Sql client and opens its own
      // transaction. Inside an existing postgres.js transaction, the matching
      // safe operation is a savepoint; supply that narrow adapter while keeping
      // every migration statement under this outer advisory-lock transaction.
      const drizzleTransactionClient = Object.assign(transactionClient, {
        options: migrationClient.options,
        begin: transactionClient.savepoint.bind(transactionClient)
      }) as unknown as ReturnType<typeof postgres>;
      const migrationDatabase = drizzle(drizzleTransactionClient, { schema });
      await migrate(migrationDatabase, { migrationsFolder: findMigrationsFolder() });
    });
    await closeMigration();

    const client = runtimeClient;
    const database = drizzle(client, { schema });
    const repositories = createRepositories(database);
    let closing: Promise<void> | undefined;
    return {
      ...repositories,
      checkReady: async () => {
        await client`select 1`;
      },
      close: async () => {
        closing ??= client.end({ timeout: 5 });
        await closing;
      }
    };
  } catch (error) {
    await Promise.allSettled([
      closeMigration(),
      ...(runtimeClient === undefined ? [] : [runtimeClient.end({ timeout: 5 })])
    ]);
    throw error;
  }
}
