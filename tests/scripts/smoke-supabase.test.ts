import { describe, expect, it, vi } from "vitest";
import {
  runSupabaseSmoke,
  validateLiveSupabaseDatabaseUrl,
  type SupabaseSmokeOperations
} from "../../scripts/smoke-supabase.js";

function operations(overrides: Partial<SupabaseSmokeOperations> = {}): SupabaseSmokeOperations {
  return {
    verifySchema: vi.fn(async () => undefined),
    insertCompany: vi.fn(async () => "company-id"),
    insertPerson: vi.fn(async () => "person-id"),
    verifyRead: vi.fn(async () => true),
    cleanupMarker: vi.fn(async () => undefined),
    countMarker: vi.fn(async () => 0),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("Supabase live smoke guard", () => {
  it.each([
    "file:///tmp/career.db",
    "https://database.example/postgres",
    "postgresql://user:password@localhost:5432/postgres",
    "postgresql://user:password@127.0.0.1:5432/postgres",
    "postgresql://user:password@[::1]:5432/postgres",
    "postgresql://user:password@database.local:5432/postgres",
    "postgresql://user:password@10.1.2.3:5432/postgres",
    "postgresql://user:password@192.168.1.10:5432/postgres",
    "postgresql://user:password@169.254.1.10:5432/postgres"
  ])("rejects unsafe database target before it can be used: %s", (value) => {
    expect(() => validateLiveSupabaseDatabaseUrl(value)).toThrow(/live Supabase PostgreSQL/i);
  });

  it("accepts a non-local PostgreSQL target", () => {
    expect(validateLiveSupabaseDatabaseUrl("postgresql://user:password@db.example.com:5432/postgres"))
      .toBe("postgresql://user:password@db.example.com:5432/postgres");
  });

  it("removes its unique marker even when the read assertion fails", async () => {
    const smoke = operations({ verifyRead: vi.fn(async () => false) });

    await expect(runSupabaseSmoke(smoke, "marker-123")).rejects.toThrow("verification failed");

    expect(smoke.cleanupMarker).toHaveBeenCalledWith("marker-123");
    expect(smoke.countMarker).toHaveBeenCalledWith("marker-123");
    expect(smoke.close).toHaveBeenCalledOnce();
  });

  it("does not leave its marker behind after a successful write/read cycle", async () => {
    const smoke = operations();

    await runSupabaseSmoke(smoke, "marker-456");

    expect(smoke.verifySchema).toHaveBeenCalledOnce();
    expect(smoke.insertCompany).toHaveBeenCalledWith("marker-456");
    expect(smoke.insertPerson).toHaveBeenCalledWith("company-id", "marker-456");
    expect(smoke.cleanupMarker).toHaveBeenCalledWith("marker-456");
    expect(smoke.countMarker).toHaveBeenCalledWith("marker-456");
    expect(smoke.close).toHaveBeenCalledOnce();
  });
});
