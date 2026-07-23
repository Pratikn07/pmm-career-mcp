import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let clientIndex = 0;
  const migrationEnd = vi.fn(async () => undefined);
  const runtimeEnd = vi.fn(async () => undefined);
  const migrationTransactionSql = vi.fn(async (_queryParts: TemplateStringsArray, ..._values: unknown[]) => []);
  const migrationSavepoint = vi.fn(async (callback: (sql: typeof migrationTransactionSql) => Promise<void>) => {
    await callback(migrationTransactionSql);
  });
  Object.assign(migrationTransactionSql, { savepoint: migrationSavepoint });
  const migrationBegin = vi.fn(async (callback: (sql: typeof migrationTransactionSql) => Promise<void>) => {
    await callback(migrationTransactionSql);
  });
  const migrationSql = Object.assign(vi.fn(async () => []), {
    begin: migrationBegin,
    end: migrationEnd,
    options: { parsers: {}, serializers: {} }
  });
  const runtimeSql = Object.assign(vi.fn(async () => []), { end: runtimeEnd });
  const postgres = vi.fn(() => {
    const client = clientIndex === 0 ? migrationSql : runtimeSql;
    clientIndex += 1;
    return client;
  });
  return {
    drizzle: vi.fn((_client: unknown, _config?: unknown) => ({})),
    migrationBegin,
    migrationEnd,
    migrationSavepoint,
    migrationSql,
    migrationTransactionSql,
    migrate: vi.fn(async (_database: unknown, _config?: unknown) => undefined),
    postgres,
    resetClientOrder: () => { clientIndex = 0; },
    runtimeEnd,
    runtimeSql
  };
});

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));

import { createDatabase } from "../../src/db/client.js";

const DATABASE_URL = "postgresql://app:secret@database.example/postgres";
const MIGRATION_DATABASE_URL = "postgresql://migration:secret@database.example/postgres";
const DATABASE_CA_CERT = "-----BEGIN CERTIFICATE-----\nZmFrZS1jYQ==\n-----END CERTIFICATE-----";
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.clearAllMocks();
  mocks.resetClientOrder();
  mocks.migrationEnd.mockResolvedValue(undefined);
  mocks.runtimeEnd.mockResolvedValue(undefined);
  mocks.migrate.mockResolvedValue(undefined);
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("production PostgreSQL client", () => {
  it.each(["file:///tmp/database", "https://database.example", "not a URL"])(
    "rejects non-PostgreSQL database URL %s before opening a pool",
    async (databaseUrl) => {
      await expect(createDatabase(databaseUrl, { requireTls: false })).rejects.toThrow(
        /PostgreSQL|postgres/i
      );
      expect(mocks.postgres).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["runtime", `${DATABASE_URL}?statement_timeout=0`],
    ["runtime", `${DATABASE_URL}?idle_in_transaction_session_timeout=0`],
    ["runtime", `${DATABASE_URL}?application_name=untrusted`],
    ["migration", `${MIGRATION_DATABASE_URL}?statement_timeout=0`],
    ["migration", `${MIGRATION_DATABASE_URL}?idle_in_transaction_session_timeout=0`],
    ["migration", `${MIGRATION_DATABASE_URL}?application_name=untrusted`]
  ])("rejects a %s URL that overrides a protected startup parameter", async (purpose, unsafeUrl) => {
    const runtimeUrl = purpose === "runtime" ? unsafeUrl : DATABASE_URL;
    const migrationDatabaseUrl = purpose === "migration" ? unsafeUrl : MIGRATION_DATABASE_URL;

    await expect(createDatabase(runtimeUrl, { migrationDatabaseUrl, requireTls: false }))
      .rejects.toThrow(/application_name|statement_timeout|idle_in_transaction_session_timeout/i);
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it("rejects URLs that override the protected legacy owner startup parameter", async () => {
    const unsafeUrl = `${MIGRATION_DATABASE_URL}?career_mcp.legacy_post_owner_subject=00000000-0000-0000-0000-000000000001`;

    await expect(createDatabase(DATABASE_URL, {
      migrationDatabaseUrl: unsafeUrl,
      requireTls: false
    })).rejects.toThrow(/legacy_post_owner_subject/i);
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it("sets the configured legacy owner only on the migration connection", async () => {
    const legacyPostOwnerSubject = "00000000-0000-0000-0000-000000000001";

    const database = await createDatabase(DATABASE_URL, {
      migrationDatabaseUrl: MIGRATION_DATABASE_URL,
      requireTls: false,
      legacyPostOwnerSubject
    });

    const postgresCalls = mocks.postgres.mock.calls as unknown as Array<[
      string,
      { connection: Record<string, unknown> }
    ]>;
    const migrationOptions = postgresCalls[0]![1];
    const runtimeOptions = postgresCalls[1]![1];
    expect(migrationOptions.connection["career_mcp.legacy_post_owner_subject"])
      .toBe(legacyPostOwnerSubject);
    expect(runtimeOptions.connection).not.toHaveProperty(
      "career_mcp.legacy_post_owner_subject"
    );
    await database.close();
  });

  it("uses separate migration and runtime pools with verified TLS and finite timeouts", async () => {
    process.env.NODE_ENV = "development";

    const database = await createDatabase(DATABASE_URL, {
      migrationDatabaseUrl: MIGRATION_DATABASE_URL,
      requireTls: true,
      tlsCaCertificate: DATABASE_CA_CERT
    });

    expect(mocks.postgres).toHaveBeenNthCalledWith(1, MIGRATION_DATABASE_URL, {
      connect_timeout: 10,
      connection: {
        application_name: "pmm-career-mcp-migration",
        idle_in_transaction_session_timeout: 30_000,
        statement_timeout: 30_000
      },
      idle_timeout: 30,
      max: 1,
      ssl: { ca: DATABASE_CA_CERT, rejectUnauthorized: true, servername: "database.example" }
    });
    expect(mocks.postgres).toHaveBeenNthCalledWith(2, DATABASE_URL, {
      connect_timeout: 10,
      connection: {
        application_name: "pmm-career-mcp-runtime",
        idle_in_transaction_session_timeout: 30_000,
        statement_timeout: 30_000
      },
      idle_timeout: 30,
      max: 5,
      ssl: { ca: DATABASE_CA_CERT, rejectUnauthorized: true, servername: "database.example" }
    });
    expect(mocks.migrationEnd).toHaveBeenCalledWith({ timeout: 5 });
    expect(mocks.runtimeEnd).not.toHaveBeenCalled();
    await database.close();
  });

  it("rejects verified TLS without a CA certificate before opening a pool", async () => {
    await expect(createDatabase(DATABASE_URL, {
      migrationDatabaseUrl: MIGRATION_DATABASE_URL,
      requireTls: true
    })).rejects.toThrow(/CA certificate/i);

    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it("runs committed migrations under a transaction-scoped advisory lock", async () => {
    const database = await createDatabase(DATABASE_URL, {
      migrationDatabaseUrl: MIGRATION_DATABASE_URL,
      requireTls: false
    });

    expect(mocks.migrationBegin).toHaveBeenCalledOnce();
    expect(mocks.migrationTransactionSql).toHaveBeenCalledOnce();
    const [queryParts] = mocks.migrationTransactionSql.mock.calls[0]!;
    expect(queryParts.join(" ")).toMatch(/pg_advisory_xact_lock.*pmm-career-mcp:migrations/i);
    expect(mocks.drizzle).toHaveBeenNthCalledWith(1, mocks.migrationTransactionSql, expect.anything());
    expect(mocks.migrate).toHaveBeenCalledOnce();

    await database.close();
  });

  it("adapts the locked postgres.js transaction for Drizzle's nested migration transaction", async () => {
    mocks.drizzle.mockImplementationOnce((client) => ({ client }));
    mocks.migrate.mockImplementationOnce(async (database) => {
      const client = (database as { client: {
        begin(callback: (sql: unknown) => Promise<void>): Promise<void>;
        options?: unknown;
      } }).client;
      expect(client.options).toBe(mocks.migrationSql.options);
      await client.begin(async () => undefined);
    });

    const database = await createDatabase(DATABASE_URL, { requireTls: false });

    expect(mocks.migrationSavepoint).toHaveBeenCalledOnce();
    await database.close();
  });

  it("does not return until committed migrations finish", async () => {
    let resolveMigration!: (value: undefined) => void;
    mocks.migrate.mockReturnValueOnce(new Promise<undefined>((resolve) => {
      resolveMigration = resolve;
    }));
    let settled = false;

    const creation = createDatabase(DATABASE_URL, { requireTls: false }).then((database) => {
      settled = true;
      return database;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveMigration(undefined);
    const database = await creation;
    expect(settled).toBe(true);
    await database.close();
  });

  it("closes the pool when migration fails", async () => {
    mocks.migrate.mockRejectedValueOnce(new Error("migration failed"));

    await expect(createDatabase(DATABASE_URL, { requireTls: false })).rejects.toThrow(
      "migration failed"
    );

    expect(mocks.migrationEnd).toHaveBeenCalledWith({ timeout: 5 });
    expect(mocks.runtimeEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("retries migration-pool shutdown after the first end attempt rejects", async () => {
    mocks.migrationEnd
      .mockRejectedValueOnce(new Error("first migration close failed"))
      .mockResolvedValueOnce(undefined);

    await expect(createDatabase(DATABASE_URL, { requireTls: false }))
      .rejects.toThrow("first migration close failed");

    expect(mocks.migrationEnd).toHaveBeenCalledTimes(2);
    expect(mocks.runtimeEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("closes the runtime pool when repository composition fails after migration", async () => {
    mocks.drizzle
      .mockReturnValueOnce({})
      .mockImplementationOnce(() => { throw new Error("runtime composition failed"); });

    await expect(createDatabase(DATABASE_URL, { requireTls: false })).rejects.toThrow(
      "runtime composition failed"
    );

    expect(mocks.migrationEnd).toHaveBeenCalledWith({ timeout: 5 });
    expect(mocks.runtimeEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("uses an awaited harmless readiness query and async shutdown", async () => {
    const database = await createDatabase(DATABASE_URL, { requireTls: false });

    await database.checkReady();
    expect(mocks.runtimeSql).toHaveBeenCalledOnce();

    await database.close();
    expect(mocks.runtimeEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("discovers committed migrations independently of the current working directory", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-client-cwd-"));

    try {
      process.chdir(temporaryDirectory);
      const database = await createDatabase(DATABASE_URL, { requireTls: false });
      expect(mocks.migrate).toHaveBeenCalledWith(
        expect.anything(),
        { migrationsFolder: expect.stringMatching(/\/drizzle$/) }
      );
      await database.close();
    } finally {
      process.chdir(originalDirectory);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
