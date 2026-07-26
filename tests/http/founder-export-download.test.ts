import { createHash } from "node:crypto";
import type { Response as SuperAgentResponse } from "superagent";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { createHttpApp } from "../../src/http/app.js";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const CAPABILITY = "A".repeat(43);
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BYTES = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80, 0x81, 0x82, 0x00
]);
const CHECKSUM = createHash("sha256").update(BYTES).digest("hex");

function collectBinary(
  response: SuperAgentResponse,
  callback: (error: Error | null, body?: Buffer) => void
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", callback);
}

function foundDownload() {
  return {
    bytes: Buffer.from(BYTES),
    fileName: "yc-founder-research.xlsx",
    mimeType: XLSX_MIME,
    checksumSha256: CHECKSUM
  };
}

describe("founder export download HTTP route", () => {
  it("returns the exact verified workbook bytes with private download headers", async () => {
    const downloadFounderExport = vi.fn(async () => foundDownload());
    const mcpHandler = vi.fn((_request, response) => response.sendStatus(501));
    const app = createHttpApp({ mcpHandler, downloadFounderExport });

    const response = await request(app)
      .get(`/research-exports/${EXPORT_ID}/download`)
      .query({ capability: CAPABILITY })
      .buffer(true)
      .parse(collectBinary);

    expect(response.status).toBe(200);
    expect(downloadFounderExport).toHaveBeenCalledOnce();
    expect(downloadFounderExport).toHaveBeenCalledWith(EXPORT_ID, CAPABILITY);
    expect(mcpHandler).not.toHaveBeenCalled();
    expect(response.headers["content-type"]).toBe(XLSX_MIME);
    expect(response.headers["content-disposition"])
      .toBe('attachment; filename="yc-founder-research.xlsx"');
    expect(response.headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(response.headers.etag).toBe(`"${CHECKSUM}"`);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body).toEqual(BYTES);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-capability"],
    ["expired", "B".repeat(43)],
    ["wrong", "C".repeat(43)]
  ])("uses the same safe not-found surface for a %s capability", async (_case, capability) => {
    const privateFailure = new DomainError(
      "NOT_FOUND",
      `private failure for ${String(capability)}`
    );
    const downloadFounderExport = vi.fn(async () => {
      throw privateFailure;
    });
    const app = createHttpApp({
      mcpHandler: (_request, response) => response.sendStatus(501),
      downloadFounderExport
    });
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined)
    ];

    try {
      const response = await request(app)
        .get(`/research-exports/${EXPORT_ID}/download`)
        .query(capability === undefined ? {} : { capability });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Founder research export is unavailable" });
      expect(response.text).not.toContain(CAPABILITY);
      if (capability !== undefined) expect(response.text).not.toContain(capability);
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("keeps malformed JSON bodies behind the same safe capability failure surface", async () => {
    const downloadFounderExport = vi.fn(async () => {
      throw new DomainError("NOT_FOUND", `private failure for ${CAPABILITY}`);
    });
    const app = createHttpApp({
      mcpHandler: (_request, response) => response.sendStatus(501),
      downloadFounderExport
    });
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined)
    ];

    try {
      const response = await request(app)
        .get(`/research-exports/${EXPORT_ID}/download`)
        .query({ capability: CAPABILITY })
        .set("content-type", "application/json")
        .send('{"incomplete":');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Founder research export is unavailable" });
      expect(downloadFounderExport).toHaveBeenCalledWith(EXPORT_ID, CAPABILITY);
      expect(response.text).not.toContain(CAPABILITY);
      expect(response.text).not.toMatch(/syntax|unexpected|\/Users\//iu);
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it.each(["head", "post", "put", "patch", "delete"] as const)(
    "does not expose or load workbook bytes for %s",
    async (method) => {
      const downloadFounderExport = vi.fn(async () => foundDownload());
      const app = createHttpApp({
        mcpHandler: (_request, response) => response.sendStatus(501),
        downloadFounderExport
      });

      const response = await request(app)
        [method](`/research-exports/${EXPORT_ID}/download`)
        .query({ capability: CAPABILITY });

      expect(response.status).toBe(404);
      expect(response.body).not.toEqual(BYTES);
      expect(response.text ?? "").not.toContain(BYTES.toString("latin1"));
      expect(downloadFounderExport).not.toHaveBeenCalled();
    }
  );
});
