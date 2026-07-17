import request from "supertest";
import type { RequestHandler } from "express";
import { expect, it, vi } from "vitest";
import { createHttpApp } from "../../src/http/app.js";

function appWithReadiness(checkReady: () => Promise<void>) {
  return createHttpApp({
    mcpHandler: ((_request, response) => response.sendStatus(501)) as RequestHandler,
    checkReady
  } as never);
}

it("keeps liveness independent from the database", async () => {
  const checkReady = vi.fn(async () => undefined);

  const response = await request(appWithReadiness(checkReady)).get("/health");

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok" });
  expect(checkReady).not.toHaveBeenCalled();
});

it("awaits the database readiness probe", async () => {
  let resolveReady!: () => void;
  const checkReady = vi.fn(() => new Promise<void>((resolve) => {
    resolveReady = resolve;
  }));

  let settled = false;
  const response = request(appWithReadiness(checkReady)).get("/ready").then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(checkReady).toHaveBeenCalledOnce());
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  resolveReady();
  const ready = await response;
  expect(ready.status).toBe(200);
  expect(ready.body).toEqual({ status: "ready" });
});

it("returns a generic unavailable response when the database is not ready", async () => {
  const response = await request(appWithReadiness(async () => {
    throw new Error("select 1 failed for postgresql://user:secret-password@db.example/postgres");
  })).get("/ready");

  expect(response.status).toBe(503);
  expect(response.body).toEqual({ status: "not_ready" });
  expect(response.text).not.toContain("secret-password");
  expect(response.text).not.toContain("select 1");
});
