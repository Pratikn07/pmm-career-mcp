import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { CareerDatabase } from "../../src/db/client.js";
import type { Company } from "../../src/db/repositories.js";
import { createCareerApplication, startServer } from "../../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function testEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "46873",
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    BASE_URL: "http://127.0.0.1:46873",
    AUTH_MODE: "none",
    LINKEDIN_PUBLISH_ENABLED: "false",
    LINKEDIN_VERSION: "202606"
  };
}

function testConfig() {
  return {
    nodeEnv: "test" as const,
    port: 0,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    migrationDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    baseUrl: "http://127.0.0.1:3000",
    authMode: "none" as const,
    oidcDiscoveryTimeoutMs: 5_000,
    linkedinPublishEnabled: false,
    linkedinVersion: "202606"
  };
}

function fakeServer(order: string[] = []) {
  let closed = false;
  const server = {
    close(callback?: (error?: Error) => void) {
      if (!closed) {
        closed = true;
        order.push("http");
      }
      callback?.();
      return server;
    }
  } as unknown as Server;
  return { server, isClosed: () => closed };
}

function fakeDatabase(
  close: () => Promise<void> = async () => undefined,
  checkReady: () => Promise<void> = async () => undefined
): CareerDatabase {
  return {
    checkReady,
    close
  } as unknown as CareerDatabase;
}

async function closeUnexpectedRuntime(value: unknown): Promise<void> {
  const runtime = value as {
    close?: () => Promise<void>;
    server?: Server;
    database?: { close(): void | Promise<void> };
  } | undefined;
  if (runtime === undefined) return;
  if (runtime.close !== undefined) {
    await runtime.close();
    return;
  }
  if (runtime.server !== undefined) {
    await new Promise<void>((resolve) => runtime.server!.close(() => resolve()));
  }
  await runtime.database?.close();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("fails closed when the production entrypoint is invoked with Docker's relative command path", async () => {
  const databasePassword = "placeholder-db-password";
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: `postgresql://app:${databasePassword}@127.0.0.1:1/career_mcp`,
      BASE_URL: "https://career.example",
      AUTH_MODE: "none"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const [code] = await once(child, "exit") as [number | null];

  expect(code).toBe(1);
  expect(output).not.toContain(databasePassword);
});

it("waits for database migration and readiness before opening the HTTP listener", async () => {
  const databaseCreation = deferred<CareerDatabase>();
  const readiness = deferred<void>();
  const database = fakeDatabase(undefined, () => readiness.promise);
  const createDatabase = vi.fn(() => databaseCreation.promise);
  const listener = fakeServer();
  const listen = vi.spyOn(express.application, "listen").mockReturnValue(listener.server);
  vi.spyOn(process, "once").mockReturnValue(process);
  const startup = Promise.resolve(startServer(testEnvironment(), { createDatabase }));
  let runtime: Awaited<typeof startup> | undefined;
  try {
    await Promise.resolve();
    expect(createDatabase).toHaveBeenCalledWith(
      "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      {
        migrationDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
        requireTls: false
      }
    );
    expect(listen).not.toHaveBeenCalled();

    databaseCreation.resolve(database);
    await Promise.resolve();
    expect(listen).not.toHaveBeenCalled();

    readiness.resolve();
    runtime = await startup;
    expect(listen).toHaveBeenCalledOnce();
  } finally {
    databaseCreation.resolve(database);
    readiness.resolve();
    runtime ??= await startup.catch(() => undefined);
    await closeUnexpectedRuntime(runtime);
  }
});

it("does not open an HTTP listener when the database readiness probe fails", async () => {
  const createDatabase = vi.fn(async () => fakeDatabase(
    async () => undefined,
    async () => { throw new Error("database readiness unavailable"); }
  ));
  const listener = fakeServer();
  const listen = vi.spyOn(express.application, "listen").mockReturnValue(listener.server);
  vi.spyOn(process, "once").mockReturnValue(process);

  await expect(startServer(testEnvironment(), { createDatabase })).rejects.toThrow("database readiness unavailable");
  expect(listen).not.toHaveBeenCalled();
});

it("passes production TLS intent from injected config instead of global process state", async () => {
  vi.stubEnv("NODE_ENV", "test");
  const createDatabase = vi.fn(async () => {
    throw new Error("stop after configuration capture");
  });
  const productionEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PORT: "46873",
    DATABASE_URL: "postgresql://career_mcp_runtime@database.example/postgres",
    MIGRATION_DATABASE_URL: "postgresql://migration_owner@database.example/postgres",
    BASE_URL: "https://career.example",
    AUTH_MODE: "oauth",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`,
    OIDC_ISSUER: "https://project.supabase.co/auth/v1",
    OIDC_AUDIENCE: "https://career.example",
    ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
    LINKEDIN_PUBLISH_ENABLED: "false",
    LINKEDIN_VERSION: "202606",
    TOKEN_ENCRYPTION_KEY: "a".repeat(64)
  };

  await expect(startServer(productionEnvironment, { createDatabase })).rejects.toThrow(
    "stop after configuration capture"
  );

  expect(createDatabase).toHaveBeenCalledWith(
    "postgresql://career_mcp_runtime@database.example/postgres",
    {
      migrationDatabaseUrl: "postgresql://migration_owner@database.example/postgres",
      requireTls: true
    }
  );
});

it("does not open an HTTP listener when database creation fails", async () => {
  const createDatabase = vi.fn(async () => {
    throw new Error("database unavailable");
  });
  const listener = fakeServer();
  const listen = vi.spyOn(express.application, "listen").mockReturnValue(listener.server);
  vi.spyOn(process, "once").mockReturnValue(process);
  const startup = Promise.resolve(startServer(testEnvironment(), { createDatabase }));
  let runtime: Awaited<typeof startup> | undefined;
  try {
    await expect(startup).rejects.toThrow("database unavailable");
    expect(listen).not.toHaveBeenCalled();
  } finally {
    runtime = await startup.catch(() => undefined);
    await closeUnexpectedRuntime(runtime);
  }
});

it("waits for every imported YC company upsert before returning search results", async () => {
  const first = deferred<Company>();
  const second = deferred<Company>();
  const pending = [first, second];
  const upsert = vi.fn(() => pending.shift()!.promise);
  const database = {
    ...fakeDatabase(),
    companies: { upsert }
  } as unknown as CareerDatabase;
  const runtime = await createCareerApplication({
    config: testConfig(),
    database,
    ycSource: {
      fetch: async () => ({
        url: "https://www.ycombinator.com/companies",
        checkedAt: "2026-07-17T12:00:00.000Z",
        html: `<!doctype html><main data-yc-company-directory>
          <article data-yc-company-id="one"><a class="company-name" href="/companies/one">One</a></article>
          <article data-yc-company-id="two"><a class="company-name" href="/companies/two">Two</a></article>
        </main>`
      })
    },
    now: () => new Date("2026-07-17T12:00:00.000Z")
  });
  const server = runtime.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Client({ name: "async-composition", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`)
    ) as never);
    let settled = false;
    const search = client.callTool({ name: "search_yc_companies", arguments: {} }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    first.resolve({ id: "stored-one" } as Company);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    second.resolve({ id: "stored-two" } as Company);
    const result = await search;
    expect(result.structuredContent).toMatchObject({
      data: { companies: [{ id: "stored-one" }, { id: "stored-two" }] }
    });
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("closes HTTP before closing the database", async () => {
  const order: string[] = [];
  let databaseClosed = false;
  const database = fakeDatabase(async () => {
    if (!databaseClosed) {
      databaseClosed = true;
      order.push("database");
    }
  });
  const listener = fakeServer(order);
  vi.spyOn(express.application, "listen").mockReturnValue(listener.server);
  vi.spyOn(process, "once").mockReturnValue(process);
  const runtime = await startServer(testEnvironment(), {
    createDatabase: async () => database
  });
  try {
    await runtime.close();
    expect(order).toEqual(["http", "database"]);
  } finally {
    await closeUnexpectedRuntime(runtime);
  }
});

it("handles competing shutdown signals only once and closes HTTP before the pool", async () => {
  const order: string[] = [];
  const databaseClose = vi.fn(async () => { order.push("database"); });
  const database = fakeDatabase(databaseClose);
  let finishClose!: () => void;
  const server = {
    close: vi.fn((callback?: (error?: Error) => void) => {
      order.push("http");
      finishClose = () => callback?.();
      return server;
    })
  } as unknown as Server;
  const handlers = new Map<string, () => void>();
  vi.spyOn(express.application, "listen").mockReturnValue(server);
  vi.spyOn(process, "once").mockImplementation((signal, handler) => {
    handlers.set(String(signal), handler as () => void);
    return process;
  });
  const runtime = await startServer(testEnvironment(), {
    createDatabase: async () => database
  });

  try {
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    expect(server.close).toHaveBeenCalledOnce();
    expect(databaseClose).not.toHaveBeenCalled();

    finishClose();
    await vi.waitFor(() => expect(databaseClose).toHaveBeenCalledOnce());
    expect(order).toEqual(["http", "database"]);
  } finally {
    await runtime.close();
  }
});
