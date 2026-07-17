import { describe, expect, it, vi } from "vitest";
import {
  resolveAndPinLiveSupabaseDatabaseUrl,
  runLiveSupabaseSmoke,
  runSupabaseSmoke,
  validateLiveSupabaseDatabaseUrl,
  type SupabaseSmokeOperations
} from "../../scripts/smoke-supabase.js";

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
    "postgresql://user:password@db.project-ref.supabase.co:5432/postgres",
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

  it("accepts only a credential-free official Supabase database hostname", () => {
    expect(validateLiveSupabaseDatabaseUrl(canonicalUrl)).toBe(canonicalUrl);
    expect(validateLiveSupabaseDatabaseUrl("postgresql://aws-0-us-east-1.pooler.supabase.com:5432/postgres"))
      .toContain("pooler.supabase.com");
  });

  it("rejects a private resolver result and never returns a pinned target", async () => {
    await expect(resolveAndPinLiveSupabaseDatabaseUrl(canonicalUrl, async () => [
      { address: "10.0.0.4", family: 4 }
    ])).rejects.toThrow(/live Supabase PostgreSQL/i);
  });

  it.each([
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1"
  ])("rejects private, mapped, and link-local IPv6 resolver results: %s", async (address) => {
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
    const createOperations = vi.fn();

    await expect(runLiveSupabaseSmoke({ DATABASE_URL: canonicalUrl }, { lookup, createOperations }))
      .rejects.toThrow("CONFIRM_LIVE_SUPABASE_SMOKE=yes");

    expect(lookup).not.toHaveBeenCalled();
    expect(createOperations).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary hostname before DNS lookup or connection creation", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    const createOperations = vi.fn();

    await expect(runLiveSupabaseSmoke({
      CONFIRM_LIVE_SUPABASE_SMOKE: "yes",
      DATABASE_URL: "postgresql://db.example.com:5432/postgres"
    }, { lookup, createOperations })).rejects.toThrow(/live Supabase PostgreSQL/i);

    expect(lookup).not.toHaveBeenCalled();
    expect(createOperations).not.toHaveBeenCalled();
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
