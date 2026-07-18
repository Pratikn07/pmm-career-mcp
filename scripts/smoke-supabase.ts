import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { validateDatabaseCaCertificate } from "../src/db/tls.js";

const REQUIRED_TABLES = [
  "settings", "companies", "people", "evidence", "targets", "target_notes",
  "outreach_drafts", "shortlists", "shortlist_entries", "post_drafts", "post_previews",
  "publish_attempts", "oauth_tokens"
] as const;

export type SupabaseSmokeTransaction = {
  verifySchema(): Promise<void>;
  insertCompany(marker: string): Promise<string>;
  insertPerson(companyId: string, marker: string): Promise<string>;
  verifyRead(marker: string): Promise<boolean>;
};

export type SupabaseSmokeOperations = {
  runRollbackTransaction(operation: (transaction: SupabaseSmokeTransaction) => Promise<void>): Promise<void>;
  verifyMarkerAbsent(marker: string): Promise<boolean>;
  closeTransactionConnection(): Promise<void>;
  closeVerificationConnection(): Promise<void>;
};

export type SupabaseMigrationOperations = {
  migrate(): Promise<void>;
  close(): Promise<void>;
};

export type DnsRecord = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsRecord[]>;
export type PinnedSupabaseDatabaseTarget = { databaseUrl: string; tlsServerName: string };

export type LiveSupabaseSmokeDependencies = {
  lookup?: DnsResolver;
  createMigrationOperations?: (
    target: PinnedSupabaseDatabaseTarget,
    tlsCaCertificate: string
  ) => Promise<SupabaseMigrationOperations>;
  createRuntimeOperations?: (
    target: PinnedSupabaseDatabaseTarget,
    tlsCaCertificate: string
  ) => Promise<SupabaseSmokeOperations>;
};

function smokeFailure(): Error {
  return new Error("Supabase smoke verification failed");
}

function invalidLiveTarget(): Error {
  return new Error("DATABASE_URL must be a live Supabase PostgreSQL URL");
}

function hostnameFromDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const allowedSupabaseHost = /^db\.[a-z0-9-]+\.supabase\.co$/.test(hostname)
      || /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || parsed.port !== "5432"
      || parsed.pathname !== "/postgres"
      || parsed.search !== ""
      || parsed.hash !== ""
      || !allowedSupabaseHost
    ) {
      throw invalidLiveTarget();
    }
    return hostname;
  } catch (error) {
    if (error instanceof Error && error.message === "DATABASE_URL must be a live Supabase PostgreSQL URL") {
      throw error;
    }
    throw invalidLiveTarget();
  }
}

/** Only accepts a canonical Supabase host before any DNS lookup or connection attempt. */
export function validateLiveSupabaseDatabaseUrl(databaseUrl: string): string {
  hostnameFromDatabaseUrl(databaseUrl);
  return databaseUrl;
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === undefined) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return !(
    first === 0
    || first === 10
    || first === 100 && second >= 64 && second <= 127
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && (second === 0 || second === 168)
    || first === 198 && (second === 18 || second === 19 || second === 51)
    || first === 203
    || first >= 224
  );
}

function isPublicIp(address: string): boolean {
  return isIP(address) === 4 && isPublicIpv4(address);
}

const defaultLookup: DnsResolver = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Resolves once, rejects all non-public answers, and pins subsequent connections to the chosen IP. */
export async function resolveAndPinLiveSupabaseDatabaseUrl(
  databaseUrl: string,
  lookup: DnsResolver = defaultLookup
): Promise<PinnedSupabaseDatabaseTarget> {
  const hostname = hostnameFromDatabaseUrl(databaseUrl);
  const records = await lookup(hostname).catch(() => { throw invalidLiveTarget(); });
  if (records.length === 0 || !records.every((record) => record.family === isIP(record.address) && isPublicIp(record.address))) {
    throw invalidLiveTarget();
  }
  const address = records[0]?.address;
  if (address === undefined) throw invalidLiveTarget();
  const pinned = new URL(databaseUrl);
  pinned.hostname = address;
  return { databaseUrl: pinned.toString(), tlsServerName: hostname };
}

/**
 * Runs marker writes inside an adapter-owned transaction that is always
 * rolled back. A separate connection then verifies that the marker is absent.
 */
export async function runSupabaseSmoke(operations: SupabaseSmokeOperations, marker: string): Promise<void> {
  let failed = false;
  try {
    await operations.runRollbackTransaction(async (transaction) => {
      await transaction.verifySchema();
      const companyId = await transaction.insertCompany(marker);
      await transaction.insertPerson(companyId, marker);
      if (!await transaction.verifyRead(marker)) throw smokeFailure();
    });
  } catch {
    failed = true;
  }

  try {
    if (!await operations.verifyMarkerAbsent(marker)) failed = true;
  } catch {
    failed = true;
  }

  const closes = await Promise.allSettled([
    operations.closeTransactionConnection(),
    operations.closeVerificationConnection()
  ]);
  if (closes.some((result) => result.status === "rejected")) failed = true;
  if (failed) throw smokeFailure();
}

/** Applies committed migrations and closes the owner connection on every path. */
export async function runSupabaseMigration(operations: SupabaseMigrationOperations): Promise<void> {
  let failed = false;
  try {
    await operations.migrate();
  } catch {
    failed = true;
  }
  try {
    await operations.close();
  } catch {
    failed = true;
  }
  if (failed) throw smokeFailure();
}

function findMigrationsFolder(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const migrationsFolder = resolve(directory, "drizzle");
    if (existsSync(resolve(directory, "package.json")) && existsSync(resolve(migrationsFolder, "meta", "_journal.json"))) {
      return migrationsFolder;
    }
    const parent = dirname(directory);
    if (parent === directory) throw smokeFailure();
    directory = parent;
  }
}

function securePostgres(target: PinnedSupabaseDatabaseTarget, tlsCaCertificate: string) {
  return postgres(target.databaseUrl, {
    max: 1,
    ssl: {
      ca: tlsCaCertificate,
      rejectUnauthorized: true,
      servername: target.tlsServerName
    }
  });
}

async function createLiveMigrationOperations(
  target: PinnedSupabaseDatabaseTarget,
  tlsCaCertificate: string
): Promise<SupabaseMigrationOperations> {
  const migrationClient = securePostgres(target, tlsCaCertificate);
  return {
    migrate: async () => {
      await migrate(drizzle(migrationClient), { migrationsFolder: findMigrationsFolder() });
    },
    close: async () => {
      await migrationClient.end({ timeout: 5 });
    }
  };
}

async function createLiveRuntimeOperations(
  target: PinnedSupabaseDatabaseTarget,
  tlsCaCertificate: string
): Promise<SupabaseSmokeOperations> {
  const transactionClient = securePostgres(target, tlsCaCertificate);
  try {
    await transactionClient`select 1`;
  } catch {
    await transactionClient.end({ timeout: 5 }).catch(() => undefined);
    throw smokeFailure();
  }
  const verificationClient = securePostgres(target, tlsCaCertificate);
  const markerYcId = (marker: string) => `mcp-supabase-smoke-${marker}`;

  return {
    runRollbackTransaction: async (operation) => {
      const expectedRollback = new Error("rollback smoke marker");
      try {
        await transactionClient.begin(async (transaction) => {
          await operation({
            verifySchema: async () => {
              const rows = await transaction<{ table_name: string }[]>`
                select table_name from information_schema.tables where table_schema = 'career_mcp'
              `;
              const available = new Set(rows.map((row) => row.table_name));
              if (!REQUIRED_TABLES.every((table) => available.has(table))) throw expectedRollback;
            },
            insertCompany: async (marker) => {
              const id = randomUUID();
              await transaction`
                insert into career_mcp.companies (id, yc_id, name, created_at, updated_at)
                values (${id}, ${markerYcId(marker)}, ${"MCP Supabase smoke marker"}, now(), now())
              `;
              return id;
            },
            insertPerson: async (companyId, marker) => {
              const id = randomUUID();
              await transaction`
                insert into career_mcp.people (id, company_id, name, role, created_at, updated_at)
                values (${id}, ${companyId}, ${`MCP smoke ${marker}`}, ${"verification"}, now(), now())
              `;
              return id;
            },
            verifyRead: async (marker) => {
              const rows = await transaction<{ found: boolean }[]>`
                select exists(
                  select 1 from career_mcp.people person
                  join career_mcp.companies company on company.id = person.company_id
                  where company.yc_id = ${markerYcId(marker)} and person.name = ${`MCP smoke ${marker}`}
                ) as found
              `;
              return rows[0]?.found === true;
            }
          });
          throw expectedRollback;
        });
      } catch (error) {
        if (error === expectedRollback) return;
        throw smokeFailure();
      }
    },
    verifyMarkerAbsent: async (marker) => {
      const rows = await verificationClient<{ count: string }[]>`
        select count(*)::text as count from career_mcp.companies where yc_id = ${markerYcId(marker)}
      `;
      return Number(rows[0]?.count ?? "0") === 0;
    },
    closeTransactionConnection: async () => {
      await transactionClient.end({ timeout: 5 });
    },
    closeVerificationConnection: async () => {
      await verificationClient.end({ timeout: 5 });
    }
  };
}

export async function runLiveSupabaseSmoke(
  env: NodeJS.ProcessEnv,
  dependencies: LiveSupabaseSmokeDependencies = {}
): Promise<void> {
  if (env.CONFIRM_LIVE_SUPABASE_SMOKE !== "yes") {
    throw new Error("Live Supabase smoke requires CONFIRM_LIVE_SUPABASE_SMOKE=yes");
  }
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the live Supabase smoke");
  }
  const migrationDatabaseUrl = env.MIGRATION_DATABASE_URL;
  if (migrationDatabaseUrl === undefined || migrationDatabaseUrl.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is required for the live Supabase smoke");
  }
  const databaseCaCertificate = env.DATABASE_CA_CERT;
  if (databaseCaCertificate === undefined || databaseCaCertificate.length === 0) {
    throw new Error("DATABASE_CA_CERT is required for the live Supabase smoke");
  }
  const tlsCaCertificate = validateDatabaseCaCertificate(databaseCaCertificate);

  // Reject either target before DNS or client creation so an invalid runtime
  // URL cannot cause the migration owner to connect first.
  validateLiveSupabaseDatabaseUrl(databaseUrl);
  validateLiveSupabaseDatabaseUrl(migrationDatabaseUrl);

  const lookup = dependencies.lookup ?? defaultLookup;
  const migrationTarget = await resolveAndPinLiveSupabaseDatabaseUrl(migrationDatabaseUrl, lookup);
  const runtimeTarget = await resolveAndPinLiveSupabaseDatabaseUrl(databaseUrl, lookup);

  const migrationOperations = await (
    dependencies.createMigrationOperations ?? createLiveMigrationOperations
  )(migrationTarget, tlsCaCertificate);
  await runSupabaseMigration(migrationOperations);

  const runtimeOperations = await (
    dependencies.createRuntimeOperations ?? createLiveRuntimeOperations
  )(runtimeTarget, tlsCaCertificate);
  await runSupabaseSmoke(runtimeOperations, randomUUID());
}

async function main(): Promise<void> {
  try {
    await runLiveSupabaseSmoke(process.env);
    process.stdout.write("Supabase smoke verification passed; transaction rollback confirmed.\n");
  } catch {
    process.stderr.write("Supabase smoke verification failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
