import {
  createFounderExportCardController,
  type FounderExportCardGlobalSource,
  type FounderExportCardGlobals,
  type FounderExportCardUi
} from "./controller.js";

type OpenAiBridge = Readonly<{
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}>;

function openAiBridge(): OpenAiBridge | undefined {
  return (window as unknown as Readonly<{ openai?: OpenAiBridge }>).openai;
}

function globalsSnapshot(): FounderExportCardGlobals {
  const bridge = openAiBridge();
  return bridge === undefined
    ? {}
    : {
        ...(bridge.toolOutput === undefined ? {} : { toolOutput: bridge.toolOutput }),
        ...(bridge.toolResponseMetadata === undefined
          ? {}
          : { toolResponseMetadata: bridge.toolResponseMetadata })
      };
}

const globals: FounderExportCardGlobalSource = {
  snapshot: globalsSnapshot,
  subscribe(listener) {
    const onGlobals = () => listener();
    window.addEventListener("openai:set_globals", onGlobals, { passive: true });
    return () => window.removeEventListener("openai:set_globals", onGlobals);
  }
};

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T | undefined {
  const value = document.getElementById(id);
  return value instanceof constructor ? value : undefined;
}

function bootstrap(): void {
  const root = element("founder-export-root", HTMLElement);
  const runId = element("export-run-id", HTMLElement);
  const createdAt = element("export-created-at", HTMLElement);
  const expiresAt = element("export-expires-at", HTMLElement);
  const rowCount = element("export-row-count", HTMLElement);
  const checksum = element("export-checksum", HTMLElement);
  const status = element("export-status", HTMLElement);
  const download = element("download-excel", HTMLButtonElement);
  if (root === undefined
    || runId === undefined
    || createdAt === undefined
    || expiresAt === undefined
    || rowCount === undefined
    || checksum === undefined
    || status === undefined
    || download === undefined) return;
  const applicationOrigin = root.getAttribute("data-application-origin");
  if (applicationOrigin === null) return;

  const ui: FounderExportCardUi = {
    render(summary) {
      runId.textContent = summary.runId;
      createdAt.textContent = summary.createdAt;
      expiresAt.textContent = summary.expiresAt;
      rowCount.textContent = `${summary.rowCount} rows across ${summary.sheetCount} sheets`;
      checksum.textContent = summary.checksumPrefix;
      status.textContent = "Private workbook ready for manual review.";
    },
    setDownloadAvailable(available) {
      download.disabled = !available;
    },
    showUnavailable(message) {
      download.disabled = true;
      status.textContent = message;
    }
  };
  const controller = createFounderExportCardController({
    applicationOrigin,
    globals,
    ui,
    openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });
  download.addEventListener("click", () => controller.download());
  controller.start();
}

if (typeof window !== "undefined" && typeof document !== "undefined") bootstrap();
