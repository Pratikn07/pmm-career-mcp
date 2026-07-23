import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createRepositories } from "./repositories.js";
import { schema } from "./schema.js";
import { validateDatabaseCaCertificate } from "./tls.js";

export type CareerDatabase = ReturnType<typeof createRepositories> & {
  checkReady(): Promise<void>;
  close(): Promise<void>;
};

export type DatabaseConnectionOptions = {
  migrationDatabaseUrl?: string;
  requireTls: boolean;
  tlsCaCertificate?: string;
  legacyPostOwnerSubject?: string;
};

type DatabaseClientPurpose = "migration" | "runtime";

const CONNECTION_TIMEOUT_SECONDS = 10;
const IDLE_TIMEOUT_SECONDS = 30;
const SESSION_TIMEOUT_MILLISECONDS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Application database URLs intentionally carry credentials and routing only.
// postgres.js forwards otherwise-unknown query keys as PostgreSQL startup
// parameters, including `options=-c ...`; accepting an unreviewed key here
// would let a URL override role, search_path, timeouts, or private GUCs.
const ALLOWED_DATABASE_URL_QUERY_PARAMETERS = new Set<string>();

function validateDatabaseUrl(
  databaseUrl: string,
  name: "DATABASE_URL" | "MIGRATION_DATABASE_URL"
): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must use the postgres or postgresql scheme`);
  }
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.toLowerCase();
    if (!ALLOWED_DATABASE_URL_QUERY_PARAMETERS.has(normalizedKey)) {
      throw new Error(`${name} contains unsupported query parameter ${normalizedKey}`);
    }
  }
  return parsed;
}

function connectionOptions(
  databaseUrl: URL,
  purpose: DatabaseClientPurpose,
  requireTls: boolean,
  tlsCaCertificate?: string,
  legacyPostOwnerSubject?: string
) {
  return {
    max: purpose === "migration" ? 1 : 5,
    connect_timeout: CONNECTION_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connection: {
      application_name: `pmm-career-mcp-${purpose}`,
      statement_timeout: SESSION_TIMEOUT_MILLISECONDS,
      idle_in_transaction_session_timeout: SESSION_TIMEOUT_MILLISECONDS,
      ...(purpose === "migration" && legacyPostOwnerSubject !== undefined
        ? { "career_mcp.legacy_post_owner_subject": legacyPostOwnerSubject }
        : {})
    },
    ...(requireTls
      ? {
          ssl: {
            ca: validateDatabaseCaCertificate(tlsCaCertificate ?? "", "TLS CA certificate"),
            rejectUnauthorized: true,
            servername: databaseUrl.hostname
          }
        }
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
  const runtimeUrl = validateDatabaseUrl(databaseUrl, "DATABASE_URL");
  const migrationDatabaseUrl = options.migrationDatabaseUrl ?? databaseUrl;
  const migrationUrl = validateDatabaseUrl(migrationDatabaseUrl, "MIGRATION_DATABASE_URL");
  const tlsCaCertificate = options.requireTls
    ? validateDatabaseCaCertificate(options.tlsCaCertificate ?? "", "TLS CA certificate")
    : undefined;
  const legacyPostOwnerSubject = options.legacyPostOwnerSubject?.toLowerCase();
  if (
    legacyPostOwnerSubject !== undefined
    && !UUID_PATTERN.test(legacyPostOwnerSubject)
  ) {
    throw new Error("legacyPostOwnerSubject must be a UUID");
  }
  const migrationClient = postgres(
    migrationDatabaseUrl,
    connectionOptions(
      migrationUrl,
      "migration",
      options.requireTls,
      tlsCaCertificate,
      legacyPostOwnerSubject
    )
  );
  let runtimeClient: ReturnType<typeof postgres> | undefined;
  let migrationClosed = false;
  let migrationClosing: Promise<void> | undefined;

  const closeMigration = async (): Promise<void> => {
    if (migrationClosed) return;
    if (migrationClosing === undefined) {
      const attempt = migrationClient.end({ timeout: 5 });
      migrationClosing = attempt;
      try {
        await attempt;
        migrationClosed = true;
      } catch (error) {
        if (migrationClosing === attempt) migrationClosing = undefined;
        throw error;
      }
      return;
    }
    await migrationClosing;
  };

  try {
    runtimeClient = postgres(
      databaseUrl,
      connectionOptions(runtimeUrl, "runtime", options.requireTls, tlsCaCertificate)
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
