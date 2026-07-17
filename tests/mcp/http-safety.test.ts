import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app.js";

function app() {
  return createHttpApp({ mcpHandler: (_request, response) => response.sendStatus(501) });
}

it("returns a sanitized MCP error and propagates a safe request ID for malformed JSON", async () => {
  const response = await request(app())
    .post("/mcp")
    .set("content-type", "application/json")
    .set("X-Request-Id", "mcp_test_request_7")
    .send('{"incomplete":');

  expect(response.status).toBe(400);
  expect(response.headers["x-request-id"]).toBe("mcp_test_request_7");
  expect(response.body).toEqual({ error: "MCP request could not be completed" });
  expect(response.text).not.toMatch(/syntax|unexpected|\/Users\//i);
});

it("bounds oversized MCP JSON bodies and still includes a generated request ID", async () => {
  const response = await request(app())
    .post("/mcp")
    .set("content-type", "application/json")
    .send(`{"payload":"${"x".repeat(1_048_576)}"}`);

  expect(response.status).toBe(413);
  expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.body).toEqual({ error: "MCP request could not be completed" });
  expect(response.text).not.toMatch(/entity\.too\.large|\/Users\//i);
});
