import type { AppConfig } from "../config.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return character;
    }
  });
}

export function hasConsentPageConfiguration(config: AppConfig): config is AppConfig & {
  supabaseUrl: string;
  supabasePublishableKey: string;
} {
  return config.authMode === "oauth"
    && config.supabaseUrl !== undefined
    && config.supabasePublishableKey !== undefined;
}

export function consentContentSecurityPolicy(supabaseUrl: string): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${new URL(supabaseUrl).origin}; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`;
}

export function applyConsentSecurityHeaders(
  response: { setHeader(name: string, value: string): void },
  supabaseUrl?: string
): void {
  response.setHeader("Content-Security-Policy", supabaseUrl === undefined
    ? "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"
    : consentContentSecurityPolicy(supabaseUrl));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
}

export function invalidConsentPage(): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Authorization unavailable</title></head><body><main><h1>Authorization unavailable</h1><p>Unable to continue authorization.</p></main></body></html>";
}

export function renderConsentPage(config: AppConfig & {
  supabaseUrl: string;
  supabasePublishableKey: string;
}, authorizationId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize access</title><script defer src="/oauth/consent-client.js"></script></head><body><main id="consent-root" data-authorization-id="${escapeHtml(authorizationId)}" data-supabase-url="${escapeHtml(config.supabaseUrl)}" data-supabase-publishable-key="${escapeHtml(config.supabasePublishableKey)}"><h1>Authorize access</h1><p id="consent-error" role="alert" hidden></p><section id="login-panel"><p>Sign in to review this request.</p><form id="login-form"><label>Email <input id="email" name="email" type="email" autocomplete="email" required></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></section><section id="approval-panel" hidden><p><span id="client-name"></span> is requesting access.</p><h2>Requested permissions</h2><ul id="scope-list"></ul><button id="approve-button" type="button">Approve</button><button id="deny-button" type="button">Deny</button></section></main></body></html>`;
}
