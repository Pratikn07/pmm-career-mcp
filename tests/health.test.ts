import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../src/http/app.js";

it("returns a non-sensitive health response", async () => {
  const response = await request(createHttpApp({ mcpHandler: (_req, res) => res.sendStatus(501) })).get("/health");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok" });
});
