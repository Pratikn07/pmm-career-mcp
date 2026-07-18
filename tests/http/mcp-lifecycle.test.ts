import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { registerMcpServerCleanup } from "../../src/http/app.js";

describe("stateless MCP response lifecycle", () => {
  it.each(["finish", "close"] as const)("closes the per-request server on response %s", async (event) => {
    const response = new EventEmitter();
    const close = vi.fn(async () => undefined);

    registerMcpServerCleanup(response as unknown as Pick<Response, "once">, { close });
    response.emit(event);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("closes the per-request server exactly once when finish and close both fire", async () => {
    const response = new EventEmitter();
    const close = vi.fn(async () => undefined);

    registerMcpServerCleanup(response as unknown as Pick<Response, "once">, { close });
    response.emit("finish");
    response.emit("close");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
