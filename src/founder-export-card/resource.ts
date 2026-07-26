import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const FOUNDER_EXPORT_CARD_URI = "ui://pmm-career-mcp/founder-export-card.html";

export type FounderExportCardResourceOptions = Readonly<{
  applicationUrl: string;
}>;

function canonicalHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("applicationUrl must be a canonical HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value
  ) {
    throw new Error("applicationUrl must be a canonical HTTPS origin");
  }
  return parsed.origin;
}

function shell(applicationOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Founder research workbook</title>
</head>
<body>
  <main id="founder-export-root" data-application-origin="${applicationOrigin}" aria-labelledby="founder-export-title">
    <h1 id="founder-export-title">Founder research workbook</h1>
    <dl>
      <dt>Run ID</dt><dd id="export-run-id"></dd>
      <dt>Created</dt><dd id="export-created-at"></dd>
      <dt>Expires</dt><dd id="export-expires-at"></dd>
      <dt>Workbook rows</dt><dd id="export-row-count"></dd>
      <dt>Checksum</dt><dd id="export-checksum"></dd>
    </dl>
    <p id="export-status" aria-live="polite"></p>
    <button id="download-excel" type="button" disabled>Download Excel</button>
  </main>
  <script defer src="${applicationOrigin}/founder-export-card-client.js"></script>
</body>
</html>`;
}

export function registerFounderExportCardResource(
  server: McpServer,
  options: FounderExportCardResourceOptions
): void {
  const applicationOrigin = canonicalHttpsOrigin(options.applicationUrl);
  const csp = {
    connect_domains: [applicationOrigin],
    resource_domains: [applicationOrigin],
    redirect_domains: [applicationOrigin]
  };
  const ui = {
    domain: applicationOrigin,
    csp: {
      connectDomains: [applicationOrigin],
      resourceDomains: [applicationOrigin]
    }
  };
  server.registerResource("founder-export-card", FOUNDER_EXPORT_CARD_URI, {
    title: "Founder research workbook",
    description: "Download a private founder research workbook for manual review.",
    mimeType: "text/html+skybridge",
    _meta: {
      ui,
      "openai/widgetDescription": "Review private workbook details and download the generated Excel file.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetDomain": applicationOrigin,
      "openai/widgetCSP": csp
    }
  }, async () => ({
    contents: [{
      uri: FOUNDER_EXPORT_CARD_URI,
      mimeType: "text/html+skybridge",
      text: shell(applicationOrigin),
      _meta: {
        ui,
        "openai/widgetDomain": applicationOrigin,
        "openai/widgetCSP": csp
      }
    }]
  }));
}
