import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const end = vi.fn(async () => undefined);
  const sql = Object.assign(vi.fn(async () => []), { end });
  return {
    drizzle: vi.fn(() => ({})),
    end,
    migrate: vi.fn(async () => undefined),
    postgres: vi.fn(() => sql),
    sql
  };
});

vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));

import { createDatabase } from "../../src/db/client.js";

const DATABASE_URL = "postgresql://app:secret@database.example/postgres";
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.clearAllMocks();
  mocks.end.mockResolvedValue(undefined);
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
      await expect(createDatabase(databaseUrl)).rejects.toThrow(/PostgreSQL|postgres/i);
      expect(mocks.postgres).not.toHaveBeenCalled();
    }
  );

  it("uses a small pool and requires TLS in production", async () => {
    process.env.NODE_ENV = "production";

    const database = await createDatabase(DATABASE_URL);

    expect(mocks.postgres).toHaveBeenCalledWith(DATABASE_URL, {
      max: 5,
      ssl: "require"
    });
    await database.close();
  });

  it("does not return until committed migrations finish", async () => {
    let resolveMigration!: (value: undefined) => void;
    mocks.migrate.mockReturnValueOnce(new Promise<undefined>((resolve) => {
      resolveMigration = resolve;
    }));
    let settled = false;

    const creation = createDatabase(DATABASE_URL).then((database) => {
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

    await expect(createDatabase(DATABASE_URL)).rejects.toThrow("migration failed");

    expect(mocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("uses an awaited harmless readiness query and async shutdown", async () => {
    const database = await createDatabase(DATABASE_URL);

    await database.checkReady();
    expect(mocks.sql).toHaveBeenCalledOnce();

    await database.close();
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("discovers committed migrations independently of the current working directory", async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "career-client-cwd-"));

    try {
      process.chdir(temporaryDirectory);
      const database = await createDatabase(DATABASE_URL);
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
