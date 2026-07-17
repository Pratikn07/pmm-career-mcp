import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createDatabase } from "../src/db/client.js";

const REQUIRED_TABLES = [
  "settings", "companies", "people", "evidence", "targets", "target_notes",
  "outreach_drafts", "shortlists", "shortlist_entries", "post_drafts", "post_previews",
  "publish_attempts", "oauth_tokens"
] as const;

export type SupabaseSmokeOperations = {
  verifySchema(): Promise<void>;
  insertCompany(marker: string): Promise<string>;
  insertPerson(companyId: string, marker: string): Promise<string>;
  verifyRead(marker: string): Promise<boolean>;
  cleanupMarker(marker: string): Promise<void>;
  countMarker(marker: string): Promise<number>;
  close(): Promise<void>;
};

function smokeFailure(): Error {
  return new Error("Supabase smoke verification failed");
}

/** Rejects development and loopback targets before a live smoke operation starts. */
export function validateLiveSupabaseDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a live Supabase PostgreSQL URL");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = hostname.split(".").map((part) => Number(part));
  const isIpv4 = ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const [firstOctet = -1, secondOctet = -1] = ipv4;
  const isPrivateIpv4 = isIpv4 && (
    firstOctet === 0
    || firstOctet === 10
    || firstOctet === 127
    || (firstOctet === 169 && secondOctet === 254)
    || (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31)
    || (firstOctet === 192 && secondOctet === 168)
  );
  const isLoopback = hostname === "localhost"
    || hostname === "::1"
    || hostname.startsWith("::ffff:127.")
    || hostname === "::"
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || hostname.startsWith("fe80:")
    || hostname.endsWith(".local")
    || isPrivateIpv4;
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || hostname.length === 0
    || isLoopback
  ) {
    throw new Error("DATABASE_URL must be a live Supabase PostgreSQL URL");
  }
  return databaseUrl;
}

/**
 * Runs the mutation portion of a smoke test. Every path attempts cleanup and
 * then checks for the marker before closing the connection.
 */
export async function runSupabaseSmoke(operations: SupabaseSmokeOperations, marker: string): Promise<void> {
  let failed = false;
  try {
    await operations.verifySchema();
    const companyId = await operations.insertCompany(marker);
    await operations.insertPerson(companyId, marker);
    if (!await operations.verifyRead(marker)) throw smokeFailure();
  } catch {
    failed = true;
  }

  try {
    await operations.cleanupMarker(marker);
    if (await operations.countMarker(marker) !== 0) failed = true;
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

async function createLiveOperations(databaseUrl: string): Promise<SupabaseSmokeOperations> {
  // This uses the application's migration runner before opening the one-off
  // smoke connection, so committed migrations are applied/verified first.
  const applicationDatabase = await createDatabase(databaseUrl, { requireTls: true });
  try {
    await applicationDatabase.checkReady();
  } finally {
    await applicationDatabase.close();
  }

  const client = postgres(databaseUrl, { max: 1, ssl: "require" });
  const markerYcId = (marker: string) => `mcp-supabase-smoke-${marker}`;

  return {
    verifySchema: async () => {
      const rows = await client<{ table_name: string }[]>`
        select table_name
        from information_schema.tables
        where table_schema = 'career_mcp'
      `;
      const available = new Set(rows.map((row) => row.table_name));
      if (!REQUIRED_TABLES.every((table) => available.has(table))) throw smokeFailure();
    },
    insertCompany: async (marker) => {
      const id = randomUUID();
      const ycId = markerYcId(marker);
      await client`
        insert into career_mcp.companies (id, yc_id, name, created_at, updated_at)
        values (${id}, ${ycId}, ${"MCP Supabase smoke marker"}, now(), now())
      `;
      return id;
    },
    insertPerson: async (companyId, marker) => {
      const id = randomUUID();
      await client`
        insert into career_mcp.people (id, company_id, name, role, created_at, updated_at)
        values (${id}, ${companyId}, ${`MCP smoke ${marker}`}, ${"verification"}, now(), now())
      `;
      return id;
    },
    verifyRead: async (marker) => {
      const rows = await client<{ found: boolean }[]>`
        select exists(
          select 1
          from career_mcp.people person
          join career_mcp.companies company on company.id = person.company_id
          where company.yc_id = ${markerYcId(marker)}
            and person.name = ${`MCP smoke ${marker}`}
        ) as found
      `;
      return rows[0]?.found === true;
    },
    cleanupMarker: async (marker) => {
      const ycId = markerYcId(marker);
      await client`
        delete from career_mcp.people
        where company_id in (select id from career_mcp.companies where yc_id = ${ycId})
      `;
      await client`delete from career_mcp.companies where yc_id = ${ycId}`;
    },
    countMarker: async (marker) => {
      const rows = await client<{ count: string }[]>`
        select count(*)::text as count
        from career_mcp.companies
        where yc_id = ${markerYcId(marker)}
      `;
      return Number(rows[0]?.count ?? "0");
    },
    close: async () => {
      await client.end({ timeout: 5 });
    }
  };
}

export async function runLiveSupabaseSmoke(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.CONFIRM_LIVE_SUPABASE_SMOKE !== "yes") {
    throw new Error("Live Supabase smoke requires CONFIRM_LIVE_SUPABASE_SMOKE=yes");
  }
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the live Supabase smoke");
  }
  const operations = await createLiveOperations(validateLiveSupabaseDatabaseUrl(databaseUrl));
  await runSupabaseSmoke(operations, randomUUID());
}

async function main(): Promise<void> {
  try {
    await runLiveSupabaseSmoke(process.env);
    process.stdout.write("Supabase smoke verification passed; cleanup confirmed.\n");
  } catch {
    process.stderr.write("Supabase smoke verification failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
