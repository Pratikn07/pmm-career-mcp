import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

// Transport-only integration: policy tests cover loopback denial separately. Bypass that boundary
// here so public fetchPublicPage behavior can be exercised against real local IPv4/IPv6 sockets.
vi.mock("../../src/research/url-policy.js", () => ({
  assertFetchableUrl: () => undefined
}));

import { fetchPublicPage } from "../../src/research/fetch-page.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }));
});

async function listen(host: string, port = 0, body = "pinned"): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<title>${body}</title><p>${body}</p>`);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to an IP address");
  }
  return address.port;
}

it("uses Node's all-address lookup contract through fetchPublicPage", async () => {
  const port = await listen("127.0.0.1");

  const result = await fetchPublicPage(`http://pinned.example:${port}/`, {
    resolveAddresses: async () => ["127.0.0.1"],
    timeoutMs: 2_000
  });

  expect(result).toMatchObject({ title: "pinned", text: "pinned", untrusted: true });
});

it("opens a newly pinned socket when the same origin resolves to a new address", async () => {
  const port = await listen("127.0.0.1", 0, "first");
  await listen("::1", port, "second");

  const first = await fetchPublicPage(`http://pinned.example:${port}/`, {
    resolveAddresses: async () => ["127.0.0.1"],
    timeoutMs: 2_000
  });
  const second = await fetchPublicPage(`http://pinned.example:${port}/`, {
    resolveAddresses: async () => ["::1"],
    timeoutMs: 2_000
  });

  expect([first.title, second.title]).toEqual(["first", "second"]);
});
