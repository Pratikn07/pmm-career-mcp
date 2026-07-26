const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/iu;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UNAVAILABLE_MESSAGE = "Workbook download is unavailable. Create a new export to continue.";

export type FounderExportCardGlobals = Readonly<{
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}>;

export type FounderExportCardGlobalSource = Readonly<{
  snapshot(): FounderExportCardGlobals;
  subscribe(listener: () => void): () => void;
}>;

export type FounderExportCardSummary = Readonly<{
  exportId: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
  rowCount: number;
  sheetCount: number;
  checksumPrefix: string;
}>;

export type FounderExportCardUi = Readonly<{
  render(summary: FounderExportCardSummary): void;
  setDownloadAvailable(available: boolean): void;
  showUnavailable(message: string): void;
}>;

export type FounderExportCardController = Readonly<{
  start(): void;
  download(): Promise<void>;
}>;

export type FounderExportOpenExternalRequest = Readonly<{
  href: string;
  redirectUrl: false;
}>;

export type FounderExportCardControllerDependencies = Readonly<{
  applicationOrigin: string;
  globals: FounderExportCardGlobalSource;
  ui: FounderExportCardUi;
  openExternal?: (request: FounderExportOpenExternalRequest) => void | Promise<void>;
  now?: () => Date;
  scheduleExpiry?(callback: () => void, delayMs: number): () => void;
}>;

type ValidatedExport = Readonly<{
  summary: FounderExportCardSummary;
}>;

type PrivateDownload = Readonly<{
  url: string;
  expiresAt: string;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (leftRecord === undefined || rightRecord === undefined) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonEqual(leftRecord[key], rightRecord[key]));
}

function canonicalHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value
  ) {
    throw new Error("Application origin is invalid");
  }
  return parsed.origin;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function safeExport(value: unknown): ValidatedExport | undefined {
  const output = record(value);
  const data = record(output?.data);
  const exportValue = record(data?.export);
  if (
    output === undefined
    || data === undefined
    || exportValue === undefined
    || !exactKeys(output, ["data"])
    || !exactKeys(data, ["export"])
    || !exactKeys(exportValue, [
      "id", "runId", "createdAt", "expiresAt", "rowCount", "sheetCount", "checksumSha256"
    ])
    || typeof exportValue.id !== "string"
    || !UUID_PATTERN.test(exportValue.id)
    || typeof exportValue.runId !== "string"
    || !UUID_PATTERN.test(exportValue.runId)
    || typeof exportValue.createdAt !== "string"
    || canonicalTimestamp(exportValue.createdAt) === undefined
    || typeof exportValue.expiresAt !== "string"
    || canonicalTimestamp(exportValue.expiresAt) === undefined
    || !Number.isSafeInteger(exportValue.rowCount)
    || (exportValue.rowCount as number) < 0
    || !Number.isSafeInteger(exportValue.sheetCount)
    || exportValue.sheetCount !== 4
    || typeof exportValue.checksumSha256 !== "string"
    || !CHECKSUM_PATTERN.test(exportValue.checksumSha256)
  ) {
    return undefined;
  }
  const createdAt = exportValue.createdAt as string;
  const expiresAt = exportValue.expiresAt as string;
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) return undefined;
  return {
    summary: {
      exportId: exportValue.id.toLowerCase(),
      runId: exportValue.runId.toLowerCase(),
      createdAt,
      expiresAt,
      rowCount: exportValue.rowCount as number,
      sheetCount: 4,
      checksumPrefix: (exportValue.checksumSha256 as string).slice(0, 12).toLowerCase()
    }
  };
}

function privateMetadata(value: unknown, expectedOutput: unknown): Record<string, unknown> | undefined {
  const metadata = record(value);
  const mcpResult = record(metadata?.mcp_tool_result);
  const hidden = record(mcpResult?._meta);
  if (
    metadata === undefined
    || mcpResult === undefined
    || hidden === undefined
    || !exactKeys(metadata, ["status", "call_tool_result", "mcp_tool_result"])
    || metadata.status !== "complete"
    || (own(mcpResult, "isError") && mcpResult.isError !== false)
    || !jsonEqual(metadata.call_tool_result, expectedOutput)
    || !own(mcpResult, "structuredContent")
    || !jsonEqual(mcpResult.structuredContent, expectedOutput)
  ) {
    return undefined;
  }
  return hidden;
}

function validatedPrivateDownload(
  metadataValue: unknown,
  expectedOutput: unknown,
  applicationOrigin: string,
  exportId: string
): PrivateDownload | undefined {
  const metadata = privateMetadata(metadataValue, expectedOutput);
  if (metadata === undefined
    || !exactKeys(metadata, ["downloadUrl", "expiresAt"])
    || typeof metadata.downloadUrl !== "string"
    || typeof metadata.expiresAt !== "string"
    || canonicalTimestamp(metadata.expiresAt) === undefined) {
    return undefined;
  }
  const prefix = `${applicationOrigin}/research-exports/${exportId}/download?capability=`;
  if (!metadata.downloadUrl.startsWith(prefix)) return undefined;
  const capability = metadata.downloadUrl.slice(prefix.length);
  if (!CAPABILITY_PATTERN.test(capability)) return undefined;
  const canonicalUrl = `${prefix}${capability}`;
  return metadata.downloadUrl === canonicalUrl
    ? { url: canonicalUrl, expiresAt: metadata.expiresAt }
    : undefined;
}

function currentTime(now: () => Date): number | undefined {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  } catch {
    return undefined;
  }
}

export function createFounderExportCardController(
  dependencies: FounderExportCardControllerDependencies
): FounderExportCardController {
  const applicationOrigin = canonicalHttpsOrigin(dependencies.applicationOrigin);
  const now = dependencies.now ?? (() => new Date());
  const scheduleExpiry = dependencies.scheduleExpiry ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  let unsubscribe: (() => void) | undefined;
  let cancelExpiry: (() => void) | undefined;
  let active: Readonly<{ export: ValidatedExport; download: PrivateDownload }> | undefined;

  function unavailable(): void {
    dependencies.ui.setDownloadAvailable(false);
    dependencies.ui.showUnavailable(UNAVAILABLE_MESSAGE);
  }

  function readyIsCurrent(value: Readonly<{ export: ValidatedExport; download: PrivateDownload }>): boolean {
    const current = currentTime(now);
    return current !== undefined
      && Date.parse(value.export.summary.expiresAt) > current
      && Date.parse(value.download.expiresAt) > current;
  }

  function clearExpiry(): void {
    cancelExpiry?.();
    cancelExpiry = undefined;
  }

  function activate(value: Readonly<{ export: ValidatedExport; download: PrivateDownload }>): boolean {
    const current = currentTime(now);
    const expiresAt = Math.min(
      Date.parse(value.export.summary.expiresAt),
      Date.parse(value.download.expiresAt)
    );
    if (current === undefined || expiresAt <= current) return false;
    try {
      cancelExpiry = scheduleExpiry(() => {
        active = undefined;
        cancelExpiry = undefined;
        unavailable();
      }, expiresAt - current);
    } catch {
      cancelExpiry = undefined;
      return false;
    }
    active = value;
    return true;
  }

  function refresh(): void {
    if (active !== undefined) return;
    let globals: FounderExportCardGlobals;
    try {
      globals = dependencies.globals.snapshot();
    } catch {
      unavailable();
      return;
    }
    const exportValue = safeExport(globals.toolOutput);
    if (exportValue === undefined) {
      unavailable();
      return;
    }
    dependencies.ui.render(exportValue.summary);
    const download = validatedPrivateDownload(
      globals.toolResponseMetadata,
      globals.toolOutput,
      applicationOrigin,
      exportValue.summary.exportId
    );
    if (download === undefined || !readyIsCurrent({ export: exportValue, download })) {
      unavailable();
      return;
    }
    if (!activate({ export: exportValue, download })) {
      unavailable();
      return;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    dependencies.ui.setDownloadAvailable(true);
  }

  return Object.freeze({
    start(): void {
      if (active !== undefined || unsubscribe !== undefined) return;
      try {
        unsubscribe = dependencies.globals.subscribe(refresh);
      } catch {
        unavailable();
        return;
      }
      refresh();
    },
    async download(): Promise<void> {
      if (active === undefined || !readyIsCurrent(active)) {
        active = undefined;
        clearExpiry();
        unavailable();
        return;
      }
      const openExternal = dependencies.openExternal;
      if (openExternal === undefined) {
        active = undefined;
        clearExpiry();
        unavailable();
        return;
      }
      try {
        await openExternal({ href: active.download.url, redirectUrl: false });
      } catch {
        active = undefined;
        clearExpiry();
        unavailable();
      }
    }
  });
}
