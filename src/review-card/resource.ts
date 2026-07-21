import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const LINKEDIN_REVIEW_CARD_URI = "ui://pmm-career-mcp/linkedin-review-card.html";

export type LinkedInReviewCardResourceOptions = Readonly<{
  baseUrl: string;
  supabaseUrl: string;
}>;

function canonicalHttpsOrigin(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a canonical HTTPS origin`);
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
    throw new Error(`${field} must be a canonical HTTPS origin`);
  }
  return parsed.origin;
}

function shell(baseUrl: string, storageOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LinkedIn post review</title>
</head>
<body>
  <main id="review-root" data-storage-origin="${storageOrigin}" aria-labelledby="review-title">
    <h1 id="review-title">LinkedIn post review</h1>
    <section aria-labelledby="content-title">
      <h2 id="content-title">Exact draft</h2>
      <p id="post-text"></p>
      <dl>
        <dt>Visibility</dt><dd id="post-visibility"></dd>
        <dt>Draft ID</dt><dd id="post-id"></dd>
        <dt>Version</dt><dd id="post-version"></dd>
        <dt>Checksum</dt><dd id="post-checksum"></dd>
        <dt>Preview expires</dt><dd id="preview-expiry"></dd>
      </dl>
    </section>
    <section aria-labelledby="media-title">
      <h2 id="media-title">Images and alt text</h2>
      <ol id="post-media"></ol>
    </section>
    <section aria-labelledby="validation-title">
      <h2 id="validation-title">Validation</h2>
      <p id="validation-status" aria-live="polite"></p>
      <ul id="validation-errors" aria-live="polite"></ul>
    </section>
    <footer>
      <button id="create-preview" type="button">Create exact preview</button>
      <button id="publish-post" type="button" disabled>Publish this exact version to LinkedIn</button>
    </footer>
  </main>
  <dialog id="publish-confirmation" aria-labelledby="confirmation-title">
    <h2 id="confirmation-title">Confirm LinkedIn publish</h2>
    <p id="confirmation-summary"></p>
    <form method="dialog">
      <button value="cancel">Cancel</button>
      <button id="confirm-publish" value="confirm">Publish this exact version</button>
    </form>
  </dialog>
  <script defer src="${baseUrl}/review-card-client.js"></script>
</body>
</html>`;
}

export function registerLinkedInReviewCardResource(
  server: McpServer,
  options: LinkedInReviewCardResourceOptions
): void {
  const baseUrl = canonicalHttpsOrigin(options.baseUrl, "baseUrl");
  const supabaseUrl = canonicalHttpsOrigin(options.supabaseUrl, "supabaseUrl");
  const csp = {
    connect_domains: [baseUrl, supabaseUrl],
    resource_domains: [baseUrl, supabaseUrl]
  };

  server.registerResource("linkedin-review-card", LINKEDIN_REVIEW_CARD_URI, {
    title: "LinkedIn post review",
    description: "Review an exact private LinkedIn draft before any app-only preview or publish action.",
    mimeType: "text/html+skybridge",
    _meta: {
      "openai/widgetDescription": "Review the full text, ordered images, alt text, visibility, version, and checksum.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": csp
    }
  }, async () => ({
    contents: [{
      uri: LINKEDIN_REVIEW_CARD_URI,
      mimeType: "text/html+skybridge",
      text: shell(baseUrl, supabaseUrl),
      _meta: { "openai/widgetCSP": csp }
    }]
  }));
}
