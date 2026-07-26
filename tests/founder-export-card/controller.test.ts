import { describe, expect, it, vi } from "vitest";
import {
  createFounderExportCardController,
  type FounderExportCardGlobals,
  type FounderExportCardGlobalSource,
  type FounderExportCardSummary,
  type FounderExportCardUi
} from "../../src/founder-export-card/controller.js";

const exportId = "123e4567-e89b-12d3-a456-426614174001";
const runId = "123e4567-e89b-12d3-a456-426614174002";
const capability = "a".repeat(43);
const applicationOrigin = "https://mcp.example";
const createdAt = "2026-07-25T12:00:00.000Z";
const expiresAt = "2026-08-01T12:00:00.000Z";
const capabilityExpiresAt = "2026-07-25T12:15:00.000Z";
const downloadUrl = `${applicationOrigin}/research-exports/${exportId}/download?capability=${capability}`;

const structuredOutput = {
  data: {
    export: {
      id: exportId,
      runId,
      createdAt,
      expiresAt,
      rowCount: 12,
      sheetCount: 4,
      checksumSha256: "b".repeat(64)
    }
  }
};

function privateMetadata(
  output: unknown = structuredOutput,
  metadata: Record<string, unknown> = { downloadUrl, expiresAt: capabilityExpiresAt }
) {
  return {
    status: "complete",
    call_tool_result: output,
    mcp_tool_result: {
      structuredContent: output,
      _meta: metadata
    }
  };
}

class Globals implements FounderExportCardGlobalSource {
  current: FounderExportCardGlobals;
  readonly listeners = new Set<() => void>();

  constructor(initial: FounderExportCardGlobals) {
    this.current = initial;
  }

  snapshot = (): FounderExportCardGlobals => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(next: FounderExportCardGlobals): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function harness(initial: FounderExportCardGlobals = {
  toolOutput: structuredOutput,
  toolResponseMetadata: privateMetadata()
}) {
  const summaries: FounderExportCardSummary[] = [];
  const availability: boolean[] = [];
  const unavailable: string[] = [];
  const opened: string[] = [];
  const globals = new Globals(initial);
  const ui: FounderExportCardUi = {
    render(summary) { summaries.push(summary); },
    setDownloadAvailable(value) { availability.push(value); },
    showUnavailable(message) { unavailable.push(message); }
  };
  const openUrl = vi.fn((url: string) => { opened.push(url); });
  const controller = createFounderExportCardController({
    applicationOrigin,
    globals,
    ui,
    openUrl,
    now: () => new Date("2026-07-25T12:05:00.000Z")
  });
  return { controller, globals, summaries, availability, unavailable, openUrl, opened };
}

describe("founder export card controller", () => {
  it("renders only the safe export summary and opens the matching private download URL", () => {
    const result = harness();

    result.controller.start();
    result.controller.download();

    expect(result.summaries).toEqual([{
      exportId,
      runId,
      createdAt,
      expiresAt,
      rowCount: 12,
      sheetCount: 4,
      checksumPrefix: "b".repeat(12)
    }]);
    expect(result.availability.at(-1)).toBe(true);
    expect(result.opened).toEqual([downloadUrl]);
    expect(result.openUrl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.summaries)).not.toContain(capability);
  });

  it("never accepts a capability URL from tool output or structured content", () => {
    const unsafeUrl = "https://attacker.example/research-exports/anything/download?capability=" + capability;
    const result = harness({
      toolOutput: {
        ...structuredOutput,
        downloadUrl: unsafeUrl,
        data: { ...structuredOutput.data, downloadUrl: unsafeUrl }
      },
      toolResponseMetadata: privateMetadata(structuredOutput, {})
    });

    result.controller.start();
    result.controller.download();

    expect(result.availability.at(-1)).toBe(false);
    expect(result.opened).toEqual([]);
    expect(JSON.stringify(result.summaries)).not.toContain(unsafeUrl);
  });

  it.each([
    ["other origin", "https://attacker.example/research-exports/123e4567-e89b-12d3-a456-426614174001/download?capability=" + capability],
    ["wrong route", `${applicationOrigin}/research-exports/${exportId}/other?capability=${capability}`],
    ["wrong export", `${applicationOrigin}/research-exports/${runId}/download?capability=${capability}`],
    ["extra query", `${downloadUrl}&next=https://attacker.example`],
    ["bad capability", `${applicationOrigin}/research-exports/${exportId}/download?capability=bad`]
  ])("fails closed for a %s private URL", (_label, privateUrl) => {
    const result = harness({
      toolOutput: structuredOutput,
      toolResponseMetadata: privateMetadata(structuredOutput, { downloadUrl: privateUrl, expiresAt: capabilityExpiresAt })
    });

    result.controller.start();
    result.controller.download();

    expect(result.availability.at(-1)).toBe(false);
    expect(result.opened).toEqual([]);
  });

  it("fails closed for unavailable, expired, and mismatched private metadata", () => {
    const unavailable = harness({ toolOutput: structuredOutput, toolResponseMetadata: undefined });
    unavailable.controller.start();
    expect(unavailable.availability.at(-1)).toBe(false);

    const expired = harness({
      toolOutput: structuredOutput,
      toolResponseMetadata: privateMetadata(structuredOutput, {
        downloadUrl,
        expiresAt: "2026-07-25T12:00:00.000Z"
      })
    });
    expired.controller.start();
    expect(expired.availability.at(-1)).toBe(false);

    const mismatched = harness({
      toolOutput: structuredOutput,
      toolResponseMetadata: privateMetadata({ data: { export: { ...structuredOutput.data.export, rowCount: 13 } } })
    });
    mismatched.controller.start();
    expect(mismatched.availability.at(-1)).toBe(false);
  });

  it("waits for a matching repeated globals update, then ignores later URL substitution", () => {
    const result = harness({ toolOutput: structuredOutput, toolResponseMetadata: undefined });

    result.controller.start();
    result.globals.emit({ toolOutput: structuredOutput, toolResponseMetadata: privateMetadata() });
    result.globals.emit({
      toolOutput: structuredOutput,
      toolResponseMetadata: privateMetadata(structuredOutput, {
        downloadUrl: `${applicationOrigin}/research-exports/${exportId}/download?capability=${"c".repeat(43)}`,
        expiresAt: capabilityExpiresAt
      })
    });
    result.controller.download();

    expect(result.availability.at(-1)).toBe(true);
    expect(result.opened).toEqual([downloadUrl]);
    expect(result.globals.listeners.size).toBe(0);
  });
});
