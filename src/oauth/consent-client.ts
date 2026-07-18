import { createClient } from "@supabase/supabase-js";
import { isSupabaseAuthorizationId } from "./authorization-id.js";

const GENERIC_ERROR = "Unable to continue authorization.";
const ALLOWED_SCOPES = new Set(["openid", "email"]);

type AuthorizationDetails = {
  authorization_id: string;
  client: { id: string; name: string };
  scope: string;
};

type OAuthRedirect = { redirect_url: string };

type AuthResult<T> = { data: T | null; error: unknown | null };

export type ConsentAuthApi = {
  getUser(): Promise<AuthResult<{ user: { id: string } | null }>>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult<unknown>>;
  getAuthorizationDetails(authorizationId: string): Promise<AuthResult<AuthorizationDetails | OAuthRedirect>>;
  approveAuthorization(authorizationId: string, options: { skipBrowserRedirect: boolean }): Promise<AuthResult<OAuthRedirect>>;
  denyAuthorization(authorizationId: string, options: { skipBrowserRedirect: boolean }): Promise<AuthResult<OAuthRedirect>>;
};

export type ConsentUi = {
  showLogin(): void;
  showConsent(details: { clientName: string; scopes: string[] }): void;
  showError(message: string): void;
  setBusy(busy: boolean): void;
  redirect(url: string): void;
};

export type ConsentController = {
  start(): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  approve(): Promise<void>;
  deny(): Promise<void>;
};

function allowedScopes(scope: string): string[] | undefined {
  const scopes = scope.split(/\s+/).filter(Boolean);
  return scopes.length > 0 && scopes.every((item) => ALLOWED_SCOPES.has(item)) ? scopes : undefined;
}

function safeRedirect(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")) return url.toString();
  } catch {
    // The generic error below deliberately does not disclose redirect details.
  }
  return undefined;
}

export function createConsentController({
  authorizationId,
  auth,
  ui
}: {
  authorizationId: string;
  auth: ConsentAuthApi;
  ui: ConsentUi;
}): ConsentController {
  let approvalAllowed = false;

  async function redirect(result: AuthResult<OAuthRedirect>): Promise<void> {
    const url = result.error === null && result.data !== null ? safeRedirect(result.data.redirect_url) : undefined;
    if (url === undefined) ui.showError(GENERIC_ERROR);
    else ui.redirect(url);
  }

  async function loadDetails(): Promise<void> {
    const result = await auth.getAuthorizationDetails(authorizationId);
    if (result.error !== null || result.data === null) {
      ui.showError(GENERIC_ERROR);
      return;
    }
    if ("redirect_url" in result.data) {
      await redirect({ data: result.data, error: result.error });
      return;
    }
    const scopes = allowedScopes(result.data.scope);
    if (scopes === undefined) {
      ui.showError(GENERIC_ERROR);
      return;
    }
    approvalAllowed = true;
    ui.showConsent({ clientName: result.data.client.name, scopes });
  }

  async function authenticated(): Promise<boolean> {
    const result = await auth.getUser();
    if (result.error !== null || result.data === null || result.data.user === null) {
      ui.showLogin();
      return false;
    }
    return true;
  }

  async function decide(action: "approve" | "deny"): Promise<void> {
    if (!isSupabaseAuthorizationId(authorizationId) || (action === "approve" && !approvalAllowed)) {
      ui.showError(GENERIC_ERROR);
      return;
    }
    ui.setBusy(true);
    try {
      await redirect(action === "approve"
        ? await auth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await auth.denyAuthorization(authorizationId, { skipBrowserRedirect: true }));
    } catch {
      ui.showError(GENERIC_ERROR);
    } finally {
      ui.setBusy(false);
    }
  }

  return {
    async start() {
      try {
        if (!isSupabaseAuthorizationId(authorizationId)) {
          ui.showError(GENERIC_ERROR);
          return;
        }
        if (await authenticated()) await loadDetails();
      } catch {
        ui.showError(GENERIC_ERROR);
      }
    },
    async signIn(email, password) {
      ui.setBusy(true);
      try {
        if (!isSupabaseAuthorizationId(authorizationId)) {
          ui.showError(GENERIC_ERROR);
          return;
        }
        const result = await auth.signInWithPassword({ email, password });
        if (result.error !== null || !(await authenticated())) {
          ui.showError(GENERIC_ERROR);
          return;
        }
        await loadDetails();
      } catch {
        ui.showError(GENERIC_ERROR);
      } finally {
        ui.setBusy(false);
      }
    },
    approve: () => decide("approve"),
    deny: () => decide("deny")
  };
}

function bootstrap(): void {
  const root = document.getElementById("consent-root");
  if (!(root instanceof HTMLElement)) return;
  const authorizationId = root.dataset.authorizationId;
  const supabaseUrl = root.dataset.supabaseUrl;
  const publishableKey = root.dataset.supabasePublishableKey;
  if (authorizationId === undefined || supabaseUrl === undefined || publishableKey === undefined) return;

  const loginPanel = document.getElementById("login-panel");
  const approvalPanel = document.getElementById("approval-panel");
  const error = document.getElementById("consent-error");
  const clientName = document.getElementById("client-name");
  const scopeList = document.getElementById("scope-list");
  const form = document.getElementById("login-form");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const approveButton = document.getElementById("approve-button");
  const denyButton = document.getElementById("deny-button");
  if (!(loginPanel instanceof HTMLElement) || !(approvalPanel instanceof HTMLElement) || !(error instanceof HTMLElement)
    || !(clientName instanceof HTMLElement) || !(scopeList instanceof HTMLUListElement) || !(form instanceof HTMLFormElement)
    || !(email instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(approveButton instanceof HTMLButtonElement)
    || !(denyButton instanceof HTMLButtonElement)) return;

  const supabase = createClient(supabaseUrl, publishableKey);
  const ui: ConsentUi = {
    showLogin() { loginPanel.hidden = false; approvalPanel.hidden = true; },
    showConsent(details) {
      loginPanel.hidden = true;
      approvalPanel.hidden = false;
      clientName.textContent = details.clientName;
      scopeList.replaceChildren(...details.scopes.map((scope) => {
        const item = document.createElement("li");
        item.textContent = scope;
        return item;
      }));
    },
    showError(message) { error.textContent = message; error.hidden = false; },
    setBusy(busy) { approveButton.disabled = busy; denyButton.disabled = busy; },
    redirect(url) { window.location.assign(url); }
  };
  const controller = createConsentController({
    authorizationId,
    auth: {
      getUser: () => supabase.auth.getUser(),
      signInWithPassword: (credentials) => supabase.auth.signInWithPassword(credentials),
      getAuthorizationDetails: (id) => supabase.auth.oauth.getAuthorizationDetails(id),
      approveAuthorization: (id, options) => supabase.auth.oauth.approveAuthorization(id, options),
      denyAuthorization: (id, options) => supabase.auth.oauth.denyAuthorization(id, options)
    },
    ui
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.signIn(email.value, password.value);
  });
  approveButton.addEventListener("click", () => { void controller.approve(); });
  denyButton.addEventListener("click", () => { void controller.deny(); });
  void controller.start();
}

if (typeof document !== "undefined") bootstrap();
