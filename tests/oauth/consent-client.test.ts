import { describe, expect, it, vi } from "vitest";
import { createConsentController, type ConsentAuthApi, type ConsentUi } from "../../src/oauth/consent-client.js";

const authorizationId = "aB09".repeat(8);

function createAuth(overrides: Partial<ConsentAuthApi> = {}): ConsentAuthApi {
  return {
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
    getAuthorizationDetails: vi.fn().mockResolvedValue({
      data: { authorization_id: authorizationId, client: { id: "client", name: "ChatGPT" }, scope: "openid email" },
      error: null
    }),
    approveAuthorization: vi.fn().mockResolvedValue({ data: { redirect_url: "https://client.example/callback" }, error: null }),
    denyAuthorization: vi.fn().mockResolvedValue({ data: { redirect_url: "https://client.example/callback?error=access_denied" }, error: null }),
    ...overrides
  };
}

function createUi(): ConsentUi & { redirects: string[] } {
  const redirects: string[] = [];
  return {
    showLogin: vi.fn(),
    showConsent: vi.fn(),
    showError: vi.fn(),
    setBusy: vi.fn(),
    redirect: (url) => redirects.push(url),
    redirects
  };
}

describe("consent browser controller", () => {
  it("does not pass an invalid authorization id to Supabase Auth", async () => {
    const auth = createAuth({ getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) });
    const ui = createUi();

    await createConsentController({ authorizationId: "not-an-id", auth, ui }).start();

    expect(auth.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
  });

  it("rejects UUID-shaped ids because Supabase authorization ids are opaque 32-character values", async () => {
    const auth = createAuth({ getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) });
    const ui = createUi();

    await createConsentController({
      authorizationId: "123e4567-e89b-42d3-a456-426614174000",
      auth,
      ui
    }).start();

    expect(auth.getUser).not.toHaveBeenCalled();
    expect(auth.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
  });

  it("shows the login form on load without approving authorization", async () => {
    const auth = createAuth();
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.start();

    expect(ui.showLogin).toHaveBeenCalledOnce();
    expect(auth.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(auth.approveAuthorization).not.toHaveBeenCalled();
  });

  it("sends the password only to Supabase Auth then displays the requested client and allowed scopes", async () => {
    const auth = createAuth({ getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) });
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.signIn("person@example.com", "correct horse battery staple");

    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "person@example.com", password: "correct horse battery staple" });
    expect(auth.getUser).toHaveBeenCalledOnce();
    expect(auth.getAuthorizationDetails).toHaveBeenCalledWith(authorizationId);
    expect(ui.showConsent).toHaveBeenCalledWith({ clientName: "ChatGPT", scopes: ["openid", "email"] });
    expect(auth.approveAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["partial openid scope", "openid"],
    ["partial email scope", "email"],
    ["duplicate openid without email", "openid openid"],
    ["duplicate email without openid", "email email"],
    ["duplicate scope", "openid email email"],
    ["unexpected scope", "openid email profile"]
  ])("rejects %s and cannot approve it", async (_label, scope) => {
    const auth = createAuth({
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      getAuthorizationDetails: vi.fn().mockResolvedValue({
        data: { authorization_id: authorizationId, client: { id: "client", name: "ChatGPT" }, scope }, error: null
      })
    });
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.start();
    await controller.approve();

    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
    expect(ui.showConsent).not.toHaveBeenCalled();
    expect(auth.approveAuthorization).not.toHaveBeenCalled();
  });

  it("clears prior approval when reloading details returns an invalid scope set", async () => {
    const auth = createAuth({
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      getAuthorizationDetails: vi.fn()
        .mockResolvedValueOnce({
          data: { authorization_id: authorizationId, client: { id: "client", name: "ChatGPT" }, scope: "email openid" }, error: null
        })
        .mockResolvedValueOnce({
          data: { authorization_id: authorizationId, client: { id: "client", name: "ChatGPT" }, scope: "openid" }, error: null
        })
    });
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.start();
    expect(ui.showConsent).toHaveBeenCalledWith({ clientName: "ChatGPT", scopes: ["email", "openid"] });

    await controller.start();
    await controller.approve();

    expect(auth.getAuthorizationDetails).toHaveBeenCalledTimes(2);
    expect(auth.approveAuthorization).not.toHaveBeenCalled();
    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
  });

  it("approves only after an explicit action and redirects to a safe callback", async () => {
    const auth = createAuth({ getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) });
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.start();
    await controller.approve();

    expect(auth.approveAuthorization).toHaveBeenCalledWith(authorizationId, { skipBrowserRedirect: true });
    expect(ui.redirects).toEqual(["https://client.example/callback"]);
  });

  it("never approves a request before allowed authorization details load", async () => {
    const auth = createAuth();
    const ui = createUi();

    await createConsentController({ authorizationId, auth, ui }).approve();

    expect(auth.approveAuthorization).not.toHaveBeenCalled();
    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
  });

  it("denies only after an explicit action and refuses unsafe callbacks", async () => {
    const auth = createAuth({
      denyAuthorization: vi.fn().mockResolvedValue({ data: { redirect_url: "javascript:alert(1)" }, error: null })
    });
    const ui = createUi();
    const controller = createConsentController({ authorizationId, auth, ui });

    await controller.deny();

    expect(auth.denyAuthorization).toHaveBeenCalledWith(authorizationId, { skipBrowserRedirect: true });
    expect(ui.redirects).toEqual([]);
    expect(ui.showError).toHaveBeenCalledWith("Unable to continue authorization.");
  });
});
