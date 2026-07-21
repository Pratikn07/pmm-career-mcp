import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReviewCardController,
  type PublishTerminalView,
  type ReviewCardGlobalSource,
  type ReviewCardGlobals,
  type ReviewCardUi,
  type ReviewCardView
} from "../../src/review-card/controller.js";

const postId = "123e4567-e89b-12d3-a456-426614174001";
const versionId = "123e4567-e89b-12d3-a456-426614174002";
const mediaId = "123e4567-e89b-12d3-a456-426614174003";
const capability = "a".repeat(43);
const storageOrigin = "https://project.supabase.co";
const signedUrl = `${storageOrigin}/storage/v1/object/sign/linkedin-draft-media/private-image?token=signed`;
const GENERIC_ERROR = "Unable to complete this action.";
const EXPIRED_ERROR = "Exact preview expired. Create a new exact preview before publishing.";

const media = [{
  position: 0,
  mediaId,
  altText: "Product launch dashboard",
  sha256: "b".repeat(64),
  mimeType: "image/png" as const,
  byteSize: 123,
  width: 640,
  height: 480,
  frameCount: 1,
  originalFilename: "launch.png",
  createdAt: "2026-07-19T12:00:00.000Z"
}];

const draftOutput = {
  data: {
    post: {
      id: postId,
      versionId,
      text: "Private launch notes",
      visibility: "CONNECTIONS",
      version: 2,
      checksum: "c".repeat(64),
      state: "ready_for_review",
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      media
    }
  }
};

const previewOutput = {
  data: {
    preview: {
      postId,
      versionId,
      text: "Private launch notes",
      visibility: "CONNECTIONS",
      version: 2,
      checksum: "c".repeat(64),
      characterCount: 20,
      media,
      expiresAt: "2026-07-19T12:15:00.000Z"
    }
  }
};

function canonicalMetadata(structuredContent: unknown, privateMetadata: Record<string, unknown>) {
  return {
    status: "complete",
    call_tool_result: structuredContent,
    mcp_tool_result: {
      content: [{ type: "text", text: "Private widget result" }],
      structuredContent,
      _meta: privateMetadata
    }
  };
}

function launcherGlobals(url = signedUrl): ReviewCardGlobals {
  return {
    toolOutput: draftOutput,
    toolResponseMetadata: canonicalMetadata(draftOutput, { mediaUrls: [url] })
  };
}

function previewMetadata(
  structuredContent: unknown = previewOutput,
  url = signedUrl,
  privateMetadata: Record<string, unknown> = {
    approvalCapability: capability,
    signedMediaUrls: [{ position: 0, url }]
  }
) {
  return canonicalMetadata(structuredContent, privateMetadata);
}

class FakeGlobalSource implements ReviewCardGlobalSource {
  current: ReviewCardGlobals;
  readonly listeners = new Set<() => void>();
  subscriptions = 0;
  readonly throwOnSubscription: number | undefined;

  constructor(initial: ReviewCardGlobals, throwOnSubscription?: number) {
    this.current = initial;
    this.throwOnSubscription = throwOnSubscription;
  }

  snapshot = (): ReviewCardGlobals => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.subscriptions += 1;
    if (this.subscriptions === this.throwOnSubscription) {
      throw new Error(`${capability} ${signedUrl}`);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(next: ReviewCardGlobals): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

type HarnessOptions = {
  initialGlobals?: ReviewCardGlobals;
  previewMode?: "event-before-promise" | "promise-before-event" | "manual";
  previewGlobalMetadata?: unknown;
  previewCallResult?: unknown;
  publishResult?: unknown;
  publishThrows?: string;
  confirmation?: boolean | Promise<boolean> | (() => boolean | Promise<boolean>);
  timeoutMs?: number;
  throwOnSubscription?: number;
  now?: () => Date;
};

function harness(options: HarnessOptions = {}) {
  const views: ReviewCardView[] = [];
  const errors: string[] = [];
  const busy: boolean[] = [];
  const publishingEnabled: boolean[] = [];
  const terminals: PublishTerminalView[] = [];
  const confirmations: Array<{ version: number; mediaCount: number; visibility: "PUBLIC" | "CONNECTIONS" }> = [];
  const globals = new FakeGlobalSource(
    options.initialGlobals ?? launcherGlobals(),
    options.throwOnSubscription
  );
  const ui: ReviewCardUi = {
    render: (view) => views.push(view),
    showError: (message) => errors.push(message),
    setBusy: (value) => busy.push(value),
    setPublishingEnabled: (value) => publishingEnabled.push(value),
    showTerminal: (value) => terminals.push(value),
    confirm: async (details) => {
      confirmations.push(details);
      return await (typeof options.confirmation === "function"
        ? options.confirmation()
        : options.confirmation ?? true);
    }
  };
  const callTool = vi.fn(async (name: string) => {
    if (name === "create_exact_linkedin_preview") {
      const callResult = options.previewCallResult ?? previewOutput;
      const next: ReviewCardGlobals = {
        ...globals.current,
        toolResponseMetadata: options.previewGlobalMetadata ?? previewMetadata(callResult)
      };
      if ((options.previewMode ?? "event-before-promise") === "event-before-promise") {
        globals.emit(next);
      } else if (options.previewMode === "promise-before-event") {
        setTimeout(() => globals.emit(next), 0);
      }
      return callResult;
    }
    if (options.publishThrows !== undefined) throw new Error(options.publishThrows);
    return options.publishResult ?? {
      structuredContent: {
        data: { result: { state: "published", postUrn: "urn:li:share:12345" } }
      }
    };
  });
  const controller = createReviewCardController({
    storageOrigin,
    globals,
    metadataTimeoutMs: options.timeoutMs ?? 20,
    callTool,
    ui,
    now: options.now ?? (() => new Date("2026-07-19T12:00:00.000Z"))
  });
  return {
    controller,
    callTool,
    globals,
    views,
    errors,
    busy,
    publishingEnabled,
    terminals,
    confirmations
  };
}

async function readyForPublish(result: ReturnType<typeof harness>): Promise<void> {
  await result.controller.start();
  await result.controller.createPreview();
  expect(result.publishingEnabled.at(-1)).toBe(true);
  result.callTool.mockClear();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LinkedIn review-card controller", () => {
  it("hydrates the canonical launcher envelope without calling any tool", async () => {
    const result = harness();

    await result.controller.start();

    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.globals.listeners.size).toBe(0);
    expect(result.views).toEqual([expect.objectContaining({
      postId,
      version: 2,
      visibility: "CONNECTIONS",
      media: [expect.objectContaining({ position: 0, altText: "Product launch dashboard", url: signedUrl })],
      previewExpiresAt: null
    })]);
    expect(result.publishingEnabled.at(-1)).toBe(false);
  });

  it("preserves multiline text and repeated spaces for exact pre-wrap rendering", async () => {
    const exactText = "Line one\nLine  two";
    const output = structuredClone(draftOutput);
    output.data.post.text = exactText;
    const result = harness({
      initialGlobals: {
        toolOutput: output,
        toolResponseMetadata: canonicalMetadata(output, { mediaUrls: [signedUrl] })
      }
    });

    await result.controller.start();

    expect(result.views[0]?.text).toBe(exactText);
  });

  it("waits for late initial tool output and canonical metadata", async () => {
    const result = harness({ initialGlobals: {}, timeoutMs: 50 });

    const start = result.controller.start();
    expect(result.globals.listeners.size).toBe(1);
    result.globals.emit(launcherGlobals());
    await start;

    expect(result.views).toHaveLength(1);
    expect(result.globals.listeners.size).toBe(0);
    expect(result.callTool).not.toHaveBeenCalled();
  });

  it("accepts legacy raw metadata only when canonical wrapper keys are absent", async () => {
    const result = harness({
      initialGlobals: { toolOutput: draftOutput, toolResponseMetadata: { mediaUrls: [signedUrl] } }
    });

    await result.controller.start();

    expect(result.views).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ["event before call promise", "event-before-promise" as const],
    ["call promise before event", "promise-before-event" as const]
  ])("correlates canonical preview metadata when the %s resolves", async (_label, previewMode) => {
    const result = harness({ previewMode, timeoutMs: 50 });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.callTool).toHaveBeenCalledWith("create_exact_linkedin_preview", { postId, version: 2 });
    expect(result.views.at(-1)).toEqual(expect.objectContaining({
      text: "Private launch notes",
      previewExpiresAt: "2026-07-19T12:15:00.000Z",
      media: [expect.objectContaining({ position: 0, url: signedUrl })]
    }));
    expect(result.publishingEnabled.at(-1)).toBe(true);
    expect(result.globals.listeners.size).toBe(0);
  });

  it("never falls back to valid raw fields on a malformed canonical wrapper", async () => {
    const malformed = {
      status: "complete",
      call_tool_result: previewOutput,
      mcp_tool_result: { structuredContent: previewOutput, _meta: {} },
      approvalCapability: capability,
      signedMediaUrls: [{ position: 0, url: signedUrl }]
    };
    const result = harness({ previewGlobalMetadata: malformed });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
    expect(result.globals.listeners.size).toBe(0);
  });

  it("ignores stale unrelated canonical metadata and accepts a later exact envelope", async () => {
    const result = harness({ previewMode: "manual", timeoutMs: 50 });
    await result.controller.start();

    const create = result.controller.createPreview();
    result.globals.emit({
      ...result.globals.current,
      toolResponseMetadata: previewMetadata({
        data: { preview: { ...previewOutput.data.preview, checksum: "d".repeat(64) } }
      })
    });
    result.globals.emit({
      ...result.globals.current,
      toolResponseMetadata: previewMetadata(previewOutput)
    });
    await create;

    expect(result.publishingEnabled.at(-1)).toBe(true);
    expect(result.views.at(-1)?.checksum).toBe("c".repeat(64));
  });

  it("never accepts stale legacy capability metadata captured before the preview call", async () => {
    const result = harness({ previewMode: "manual", timeoutMs: 5 });
    await result.controller.start();
    result.globals.current = {
      ...result.globals.current,
      toolResponseMetadata: {
        approvalCapability: capability,
        signedMediaUrls: [{ position: 0, url: signedUrl }]
      }
    };

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
  });

  it.each([
    ["raw", {
      approvalCapability: capability,
      signedMediaUrls: [{ position: 0, url: signedUrl }]
    }],
    ["direct _meta", {
      _meta: {
        approvalCapability: capability,
        signedMediaUrls: [{ position: 0, url: signedUrl }]
      }
    }]
  ])("never accepts stale %s capability metadata re-snapshotted by an unrelated post-dispatch event", async (_label, staleMetadata) => {
    const result = harness({ previewMode: "manual", timeoutMs: 5 });
    await result.controller.start();
    result.globals.current = {
      ...result.globals.current,
      toolResponseMetadata: staleMetadata
    };

    const create = result.controller.createPreview();
    result.globals.emit(result.globals.current);
    await create;

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
    await result.controller.publish();
    expect(result.callTool).toHaveBeenCalledTimes(1);
    expect(result.callTool).toHaveBeenCalledWith("create_exact_linkedin_preview", { postId, version: 2 });
  });

  it.each([
    ["string", "true"],
    ["number", 1]
  ])("fails closed when preview isError has a malformed %s value", async (_label, isError) => {
    const result = harness({
      previewCallResult: { isError, structuredContent: previewOutput },
      previewGlobalMetadata: previewMetadata(previewOutput),
      timeoutMs: 5
    });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
  });

  it("accepts a preview envelope whose isError field is exactly false", async () => {
    const result = harness({
      previewCallResult: { isError: false, structuredContent: previewOutput },
      previewGlobalMetadata: previewMetadata(previewOutput)
    });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("times out and removes its listener when no matching preview metadata arrives", async () => {
    const result = harness({ previewMode: "manual", timeoutMs: 5 });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.errors).toEqual([GENERIC_ERROR]);
    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.globals.listeners.size).toBe(0);
  });

  it("contains metadata-listener setup failures and restores the non-busy state", async () => {
    const result = harness({ throwOnSubscription: 2 });
    await result.controller.start();

    await expect(result.controller.createPreview()).resolves.toBeUndefined();

    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.errors).toEqual([GENERIC_ERROR]);
    expect(result.busy.at(-1)).toBe(false);
    expect(JSON.stringify(result.errors)).not.toContain(capability);
    expect(JSON.stringify(result.errors)).not.toContain("supabase.co");
  });

  it.each([
    ["media count", { approvalCapability: capability, signedMediaUrls: [] }],
    ["media position", { approvalCapability: capability, signedMediaUrls: [{ position: 1, url: signedUrl }] }]
  ])("rejects canonical preview metadata with mismatched %s", async (_label, hidden) => {
    const result = harness({
      previewGlobalMetadata: previewMetadata(previewOutput, signedUrl, hidden),
      timeoutMs: 5
    });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
  });

  it.each([
    ["wrong origin", "https://evil.example/storage/v1/object/sign/linkedin-draft-media/private?token=signed"],
    ["wrong bucket", `${storageOrigin}/storage/v1/object/sign/other-bucket/private?token=signed`],
    ["public-object path", `${storageOrigin}/storage/v1/object/public/linkedin-draft-media/private`]
  ])("rejects a launcher image URL with %s", async (_label, url) => {
    const result = harness({ initialGlobals: launcherGlobals(url), timeoutMs: 5 });

    await result.controller.start();

    expect(result.views).toHaveLength(0);
    expect(result.errors).toEqual([GENERIC_ERROR]);
    expect(result.publishingEnabled.at(-1)).toBe(false);
  });

  it.each([
    ["wrong origin", "https://evil.example/storage/v1/object/sign/linkedin-draft-media/private?token=signed"],
    ["wrong signed path", `${storageOrigin}/storage/v1/object/public/linkedin-draft-media/private`]
  ])("rejects preview metadata with %s", async (_label, url) => {
    const result = harness({ previewGlobalMetadata: previewMetadata(previewOutput, url), timeoutMs: 5 });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([GENERIC_ERROR]);
  });

  it("cannot publish before a separate exact-preview action", async () => {
    const result = harness();
    await result.controller.start();

    await result.controller.publish();

    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.errors).toEqual([GENERIC_ERROR]);
  });

  it("does not call publish when confirmation is cancelled", async () => {
    const result = harness({ confirmation: false });
    await readyForPublish(result);

    await result.controller.publish();

    expect(result.confirmations).toEqual([{ version: 2, mediaCount: 1, visibility: "CONNECTIONS" }]);
    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.terminals).toEqual([]);
    expect(result.publishingEnabled.at(-1)).toBe(true);
  });

  it("never enables publishing for an already expired exact preview", async () => {
    const result = harness({ now: () => new Date("2026-07-19T12:15:00.000Z") });
    await result.controller.start();

    await result.controller.createPreview();

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([EXPIRED_ERROR]);
    expect(result.callTool).toHaveBeenCalledTimes(1);
  });

  it("disables publishing when an open exact preview reaches expiry", async () => {
    vi.useFakeTimers();
    let currentTime = new Date("2026-07-19T12:00:00.000Z");
    const result = harness({ now: () => currentTime });
    await readyForPublish(result);

    currentTime = new Date("2026-07-19T12:15:00.000Z");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);

    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(result.errors).toEqual([EXPIRED_ERROR]);
    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.terminals).toEqual([]);
  });

  it("rechecks expiry after confirmation and does not dispatch or report ambiguity", async () => {
    let now = new Date("2026-07-19T12:00:00.000Z");
    const result = harness({
      now: () => now,
      confirmation: () => {
        now = new Date("2026-07-19T12:15:00.000Z");
        return true;
      }
    });
    await readyForPublish(result);

    await result.controller.publish();

    expect(result.callTool).not.toHaveBeenCalled();
    expect(result.errors).toEqual([EXPIRED_ERROR]);
    expect(result.terminals).toEqual([]);
    expect(result.publishingEnabled.at(-1)).toBe(false);
  });

  it.each([
    ["published", { state: "published", postUrn: "urn:li:share:12345" }, "published"],
    ["media upload failed", { state: "media_upload_failed" }, "definite_failure"],
    ["post failed", { state: "publish_failed" }, "definite_failure"],
    ["media upload unknown", { state: "media_upload_unknown" }, "ambiguous"],
    ["post unknown", { state: "publish_unknown" }, "ambiguous"]
  ])("renders terminal %s distinctly and never permits a second action", async (_label, publishResult, kind) => {
    const result = harness({
      publishResult: { structuredContent: { data: { result: publishResult } } }
    });
    await readyForPublish(result);

    await result.controller.publish();
    await result.controller.publish();
    await result.controller.createPreview();

    expect(result.callTool).toHaveBeenCalledTimes(1);
    expect(result.callTool).toHaveBeenCalledWith("publish_exact_linkedin_post", { approvalCapability: capability });
    expect(result.terminals).toEqual([expect.objectContaining({ kind })]);
    expect(result.publishingEnabled.at(-1)).toBe(false);
    expect(JSON.stringify(result.terminals)).not.toContain(capability);
    expect(JSON.stringify(result.terminals)).not.toContain("supabase.co");
  });

  it.each([
    ["resolved MCP error", { isError: true, structuredContent: { data: { result: { state: "published", postUrn: "urn:li:share:12345" } } } }],
    ["malformed published result", { structuredContent: { data: { result: { state: "published", postUrn: "secret-invalid-urn" } } } }],
    ["unexpected state", { structuredContent: { data: { result: { state: "retrying" } } } }],
    ["missing structured result", { content: [{ type: "text", text: capability }] }]
  ])("treats a %s as terminal ambiguity without leaking details", async (_label, publishResult) => {
    const result = harness({ publishResult });
    await readyForPublish(result);

    await result.controller.publish();
    await result.controller.publish();

    expect(result.callTool).toHaveBeenCalledTimes(1);
    expect(result.terminals).toEqual([expect.objectContaining({ kind: "ambiguous" })]);
    expect(JSON.stringify(result.terminals)).not.toContain(capability);
  });

  it("treats a thrown publish transport failure as terminal ambiguity without retry", async () => {
    const result = harness({ publishThrows: `${capability} ${signedUrl}` });
    await readyForPublish(result);

    await result.controller.publish();
    await result.controller.publish();

    expect(result.callTool).toHaveBeenCalledTimes(1);
    expect(result.terminals).toEqual([expect.objectContaining({ kind: "ambiguous" })]);
    expect(JSON.stringify(result.terminals)).not.toContain(capability);
    expect(JSON.stringify(result.terminals)).not.toContain("supabase.co");
  });

  it("suppresses duplicate preview and publish clicks while busy", async () => {
    let resolvePreview!: (value: unknown) => void;
    const previewPromise = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    const result = harness({ previewMode: "manual", previewCallResult: previewPromise, timeoutMs: 50 });
    await result.controller.start();

    const firstPreview = result.controller.createPreview();
    const secondPreview = result.controller.createPreview();
    expect(result.callTool).toHaveBeenCalledTimes(1);
    resolvePreview(previewOutput);
    result.globals.emit({ ...result.globals.current, toolResponseMetadata: previewMetadata(previewOutput) });
    await Promise.all([firstPreview, secondPreview]);

    expect(result.publishingEnabled.at(-1)).toBe(true);
    expect(result.busy).toContain(true);
    expect(result.busy.at(-1)).toBe(false);
  });

  it("suppresses duplicate publish clicks while the one terminal call is pending", async () => {
    let resolvePublish!: (value: unknown) => void;
    const pendingPublish = new Promise<unknown>((resolve) => { resolvePublish = resolve; });
    const result = harness({ publishResult: pendingPublish });
    await readyForPublish(result);

    const first = result.controller.publish();
    const second = result.controller.publish();
    await vi.waitFor(() => expect(result.callTool).toHaveBeenCalledTimes(1));
    resolvePublish({
      structuredContent: { data: { result: { state: "published", postUrn: "urn:li:share:12345" } } }
    });
    await Promise.all([first, second]);

    expect(result.callTool).toHaveBeenCalledTimes(1);
    expect(result.terminals).toEqual([expect.objectContaining({ kind: "published" })]);
  });
});
