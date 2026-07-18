import { describe, expect, it, vi } from "vitest";
import {
  resolveAndPinLiveSupabaseDatabaseUrl,
  runLiveSupabaseSmoke,
  runSupabaseMigration,
  runSupabaseSmoke,
  validateLiveSupabaseDatabaseUrl,
  type PinnedSupabaseDatabaseTarget,
  type SupabaseMigrationOperations,
  type SupabaseSmokeOperations
} from "../../scripts/smoke-supabase.js";

function migrationOperations(overrides: Partial<SupabaseMigrationOperations> = {}): SupabaseMigrationOperations {
  return {
    migrate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

function operations(overrides: Partial<SupabaseSmokeOperations> = {}): SupabaseSmokeOperations {
  const transaction = {
    verifySchema: vi.fn(async () => undefined),
    insertCompany: vi.fn(async () => "company-id"),
    insertPerson: vi.fn(async () => "person-id"),
    verifyRead: vi.fn(async () => true)
  };
  return {
    runRollbackTransaction: vi.fn(async (operation) => operation(transaction)),
    verifyMarkerAbsent: vi.fn(async () => true),
    closeTransactionConnection: vi.fn(async () => undefined),
    closeVerificationConnection: vi.fn(async () => undefined),
    ...overrides
  };
}

const canonicalUrl = "postgresql://db.project-ref.supabase.co:5432/postgres";

describe("Supabase live target guard", () => {
  it.each([
    "file:///tmp/career.db",
    "https://db.project-ref.supabase.co/postgres",
    "postgresql://db.project-ref.supabase.co:6543/postgres",
    "postgresql://db.project-ref.supabase.co:5432/not-postgres",
    "postgresql://db.project-ref.supabase.co:5432/postgres?sslmode=require",
    "postgresql://db.project-ref.supabase.co:5432/postgres#fragment",
    "postgresql://localhost.:5432/postgres",
    "postgresql://127.0.0.1:5432/postgres",
    "postgresql://[::1]:5432/postgres",
    "postgresql://db.project-ref.supabase.co.local:5432/postgres",
    "postgresql://api.supabase.co:5432/postgres",
    "postgresql://db.example.com:5432/postgres"
  ])("rejects unsafe database URL syntax before DNS or connection: %s", (value) => {
    expect(() => validateLiveSupabaseDatabaseUrl(value)).toThrow(/live Supabase PostgreSQL/i);
  });

  it("accepts an official Supabase database hostname with private URL credentials", () => {
    expect(validateLiveSupabaseDatabaseUrl(canonicalUrl)).toBe(canonicalUrl);
    expect(validateLiveSupabaseDatabaseUrl(
      "postgresql://postgres.project-ref:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    )).toContain("pooler.supabase.com");
    expect(validateLiveSupabaseDatabaseUrl("postgresql://aws-0-us-east-1.pooler.supabase.com:5432/postgres"))
      .toContain("pooler.supabase.com");
  });

  it("rejects a private resolver result and never returns a pinned target", async () => {
    await expect(resolveAndPinLiveSupabaseDatabaseUrl(canonicalUrl, async () => [
      { address: "10.0.0.4", family: 4 }
    ])).rejects.toThrow(/live Supabase PostgreSQL/i);
  });

  it.each([
    "2606:4700:4700::1111",
    "64:ff9b::c000:0201",
    "2002:c000:0201::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1"
  ])("rejects every IPv6 resolver result, including mapped and transition forms: %s", async (address) => {
    await expect(resolveAndPinLiveSupabaseDatabaseUrl(canonicalUrl, async () => [{ address, family: 6 }]))
      .rejects.toThrow(/live Supabase PostgreSQL/i);
  });

  it("pins a public DNS result rather than reconnecting by hostname", async () => {
    const pinned = await resolveAndPinLiveSupabaseDatabaseUrl(canonicalUrl, async () => [
      { address: "1.1.1.1", family: 4 }
    ]);

    expect(pinned.databaseUrl).toContain("1.1.1.1");
    expect(pinned.tlsServerName).toBe("db.project-ref.supabase.co");
  });

  it("requires confirmation before DNS lookup or any operation factory", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    const createMigrationOperations = vi.fn();
    const createRuntimeOperations = vi.fn();

    await expect(runLiveSupabaseSmoke({
      DATABASE_URL: canonicalUrl,
      MIGRATION_DATABASE_URL: canonicalUrl
    }, { lookup, createMigrationOperations, createRuntimeOperations }))
      .rejects.toThrow("CONFIRM_LIVE_SUPABASE_SMOKE=yes");

    expect(lookup).not.toHaveBeenCalled();
    expect(createMigrationOperations).not.toHaveBeenCalled();
    expect(createRuntimeOperations).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary hostname before DNS lookup or connection creation", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    const createMigrationOperations = vi.fn();
    const createRuntimeOperations = vi.fn();

    await expect(runLiveSupabaseSmoke({
      CONFIRM_LIVE_SUPABASE_SMOKE: "yes",
      DATABASE_URL: "postgresql://db.example.com:5432/postgres",
      MIGRATION_DATABASE_URL: canonicalUrl
    }, { lookup, createMigrationOperations, createRuntimeOperations })).rejects.toThrow(/live Supabase PostgreSQL/i);

    expect(lookup).not.toHaveBeenCalled();
    expect(createMigrationOperations).not.toHaveBeenCalled();
    expect(createRuntimeOperations).not.toHaveBeenCalled();
  });

  it("passes a credential-bearing pooler URL privately to the pinned client factory", async () => {
    const createMigrationOperations = vi.fn(async (_target: PinnedSupabaseDatabaseTarget) => migrationOperations());
    const createRuntimeOperations = vi.fn(async (_target: PinnedSupabaseDatabaseTarget) => operations());
    const databaseUrl = "postgresql://postgres.project-ref:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres";

    await runLiveSupabaseSmoke({
      CONFIRM_LIVE_SUPABASE_SMOKE: "yes",
      DATABASE_URL: databaseUrl,
      MIGRATION_DATABASE_URL: databaseUrl
    }, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      createMigrationOperations,
      createRuntimeOperations
    });

    const target = createRuntimeOperations.mock.calls[0]?.[0];
    if (target === undefined) throw new Error("client factory was not called");
    const pinnedUrl = new URL(target.databaseUrl);
    expect(pinnedUrl.hostname).toBe("1.1.1.1");
    expect(pinnedUrl.username).toBe("postgres.project-ref");
    expect(pinnedUrl.password).toBe("fake-password");
  });

  it("uses the migration URL only for migrations and the runtime URL only for DML verification", async () => {
    const migration = migrationOperations();
    const runtime = operations();
    const createMigrationOperations = vi.fn(async (_target: PinnedSupabaseDatabaseTarget) => migration);
    const createRuntimeOperations = vi.fn(async (_target: PinnedSupabaseDatabaseTarget) => runtime);
    const migrationUrl = "postgresql://postgres.project-ref:owner-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    const runtimeUrl = "postgresql://career_mcp_runtime.project-ref:runtime-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres";

    await runLiveSupabaseSmoke({
      CONFIRM_LIVE_SUPABASE_SMOKE: "yes",
      DATABASE_URL: runtimeUrl,
      MIGRATION_DATABASE_URL: migrationUrl
    }, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      createMigrationOperations,
      createRuntimeOperations
    });

    expect(new URL(createMigrationOperations.mock.calls[0]![0].databaseUrl).username).toBe("postgres.project-ref");
    expect(new URL(createRuntimeOperations.mock.calls[0]![0].databaseUrl).username).toBe("career_mcp_runtime.project-ref");
    expect(migration.migrate).toHaveBeenCalledOnce();
    expect(migration.close).toHaveBeenCalledOnce();
    expect(runtime.runRollbackTransaction).toHaveBeenCalledOnce();
    expect(runtime.closeTransactionConnection).toHaveBeenCalledOnce();
    expect(runtime.closeVerificationConnection).toHaveBeenCalledOnce();
  });
});

describe("Supabase migration setup", () => {
  it("closes the migration connection when migration succeeds", async () => {
    const migration = migrationOperations();

    await runSupabaseMigration(migration);

    expect(migration.migrate).toHaveBeenCalledOnce();
    expect(migration.close).toHaveBeenCalledOnce();
  });

  it("closes the migration connection and fails safely when migration rejects", async () => {
    const migration = migrationOperations({
      migrate: vi.fn(async () => { throw new Error("private migration error"); })
    });

    await expect(runSupabaseMigration(migration)).rejects.toThrow("verification failed");

    expect(migration.close).toHaveBeenCalledOnce();
  });

  it("fails safely when closing the migration connection rejects", async () => {
    const migration = migrationOperations({
      close: vi.fn(async () => { throw new Error("private close error"); })
    });

    await expect(runSupabaseMigration(migration)).rejects.toThrow("verification failed");
    expect(migration.close).toHaveBeenCalledOnce();
  });
});

describe("Supabase smoke rollback and fresh verification", () => {
  it("rolls back the marker transaction and performs a fresh absence check after a failed read", async () => {
    const failingRead = operations({
      runRollbackTransaction: vi.fn(async (operation: (transaction: {
        verifySchema(): Promise<void>;
        insertCompany(marker: string): Promise<string>;
        insertPerson(companyId: string, marker: string): Promise<string>;
        verifyRead(marker: string): Promise<boolean>;
      }) => Promise<void>) => {
        await operation({
          verifySchema: vi.fn(async () => undefined),
          insertCompany: vi.fn(async () => "company-id"),
          insertPerson: vi.fn(async () => "person-id"),
          verifyRead: vi.fn(async () => false)
        });
      })
    });

    await expect(runSupabaseSmoke(failingRead, "marker-123")).rejects.toThrow("verification failed");

    expect(failingRead.runRollbackTransaction).toHaveBeenCalledOnce();
    expect(failingRead.verifyMarkerAbsent).toHaveBeenCalledWith("marker-123");
    expect(failingRead.closeTransactionConnection).toHaveBeenCalledOnce();
    expect(failingRead.closeVerificationConnection).toHaveBeenCalledOnce();
  });

  it("checks the fresh connection even when marker insertion aborts the transaction", async () => {
    const smoke = operations({
      runRollbackTransaction: vi.fn(async (operation) => operation({
        verifySchema: vi.fn(async () => undefined),
        insertCompany: vi.fn(async () => { throw new Error("insert failure"); }),
        insertPerson: vi.fn(async () => "person-id"),
        verifyRead: vi.fn(async () => true)
      }))
    });

    await expect(runSupabaseSmoke(smoke, "marker-456")).rejects.toThrow("verification failed");

    expect(smoke.verifyMarkerAbsent).toHaveBeenCalledWith("marker-456");
    expect(smoke.closeTransactionConnection).toHaveBeenCalledOnce();
    expect(smoke.closeVerificationConnection).toHaveBeenCalledOnce();
  });

  it("attempts independent fresh verification and both closes when transaction or verification fails", async () => {
    const smoke = operations({
      runRollbackTransaction: vi.fn(async () => { throw new Error("transaction failure"); }),
      verifyMarkerAbsent: vi.fn(async () => { throw new Error("verification failure"); }),
      closeTransactionConnection: vi.fn(async () => { throw new Error("close failure"); })
    });

    await expect(runSupabaseSmoke(smoke, "marker-789")).rejects.toThrow("verification failed");

    expect(smoke.verifyMarkerAbsent).toHaveBeenCalledWith("marker-789");
    expect(smoke.closeTransactionConnection).toHaveBeenCalledOnce();
    expect(smoke.closeVerificationConnection).toHaveBeenCalledOnce();
  });

  it("uses the transaction and fresh verifier when the marker flow succeeds", async () => {
    const smoke = operations();

    await runSupabaseSmoke(smoke, "marker-000");

    expect(smoke.runRollbackTransaction).toHaveBeenCalledOnce();
    expect(smoke.verifyMarkerAbsent).toHaveBeenCalledWith("marker-000");
    expect(smoke.closeTransactionConnection).toHaveBeenCalledOnce();
    expect(smoke.closeVerificationConnection).toHaveBeenCalledOnce();
  });
});
