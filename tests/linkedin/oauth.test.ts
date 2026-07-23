import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../support/database.js";
import { decryptJson } from "../../src/security/crypto.js";
import { DomainError } from "../../src/domain/errors.js";
import { createLinkedInOAuth } from "../../src/linkedin/oauth.js";

const KEY = "a".repeat(64);
const db = await createTestDatabase();
let now = Date.parse("2026-07-17T12:00:00.000Z");

afterEach(async () => {
  (await db.resetForTests());
  now = Date.parse("2026-07-17T12:00:00.000Z");
});
afterAll(async () => (await db.close()));

function fakeRandomBytes(size: number): Buffer {
  return Buffer.alloc(size, 7);
}

function oauth(fetch = vi.fn()) {
  return createLinkedInOAuth(db, {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://career.example.com/linkedin/callback",
    tokenEncryptionKey: KEY,
    fetch,
    clock: () => new Date(now),
    randomBytes: fakeRandomBytes
  });
}

describe("LinkedIn OAuth", () => {
  it("creates a confidential web authorization URL with extended login and no native PKCE fields", () => {
    const authorizationUrl = oauth().createAuthorizationUrl();
    const url = new URL(authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("enable_extended_login")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://career.example.com/linkedin/callback");
    expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(
      new Set(["openid", "profile", "w_member_social"])
    );
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
    expect(url.searchParams.get("code_verifier")).toBeNull();
  });

  it("exchanges a state only once, encrypts token and author identity, and returns no token", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token-that-must-not-leak",
        expires_in: 3600,
        refresh_token: "refresh-token-that-must-not-leak"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "person-123", name: "Pratik" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const service = oauth(fetch);
    const authorizationUrl = new URL(service.createAuthorizationUrl());
    const state = authorizationUrl.searchParams.get("state")!;

    await expect(service.exchangeCallback({ code: "authorization-code", state })).resolves.toEqual({
      connected: true
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenRequest] = fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(tokenRequest.method).toBe("POST");
    const form = new URLSearchParams(String(tokenRequest.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "authorization-code",
      redirect_uri: "https://career.example.com/linkedin/callback",
      client_id: "client-id",
      client_secret: "client-secret"
    });
    expect(form.has("code_verifier")).toBe(false);

    const stored = (await db.oauthTokens.getByProvider("linkedin"))!;
    expect(JSON.stringify(stored)).not.toContain("access-token-that-must-not-leak");
    expect(JSON.stringify(stored)).not.toContain("refresh-token-that-must-not-leak");
    expect(decryptJson(JSON.parse(stored.ciphertext), KEY)).toEqual({
      credentialVersion: 1,
      accessToken: "access-token-that-must-not-leak",
      authorUrn: "urn:li:person:person-123",
      grantedScopes: ["openid", "profile", "w_member_social"]
    });
    expect(decryptJson(JSON.parse(stored.refreshMetadataCiphertext!), KEY)).toEqual({
      refreshToken: "refresh-token-that-must-not-leak"
    });
    await expect(service.exchangeCallback({ code: "another-code", state })).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID"
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a partial grant", "openid profile"],
    ["an unexpected grant", "openid profile w_member_social email"],
    ["a duplicate grant", "openid profile w_member_social profile"],
    ["an empty grant", ""]
  ])("rejects %s reported by the token endpoint before identity lookup or persistence", async (_label, scope) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "scope-test-token",
      expires_in: 3600,
      scope
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = oauth(fetch);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;

    await expect(service.exchangeCallback({ code: "authorization-code", state })).rejects.toMatchObject({
      code: "OAUTH_PROVIDER_ERROR",
      details: { stage: "token_scope" }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await db.oauthTokens.getByProvider("linkedin")).toBeUndefined();
  });

  it("accepts the exact required scope set when LinkedIn reports it in a different order", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "exact-scope-token",
        expires_in: 3600,
        scope: "w_member_social openid profile"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "exact-person" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const service = oauth(fetch);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;

    await expect(service.exchangeCallback({ code: "authorization-code", state })).resolves.toEqual({
      connected: true
    });
    const stored = (await db.oauthTokens.getByProvider("linkedin"))!;
    expect(decryptJson(JSON.parse(stored.ciphertext), KEY)).toMatchObject({
      credentialVersion: 1,
      grantedScopes: ["openid", "profile", "w_member_social"]
    });
  });

  it("rejects expired state before exchanging a code", async () => {
    const fetch = vi.fn();
    const service = oauth(fetch);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;
    now += 10 * 60 * 1_000;

    await expect(service.exchangeCallback({ code: "authorization-code", state })).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces provider failures without response bodies or credentials", async () => {
    const privateValue = "access-token-in-provider-body";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      access_token: privateValue
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const service = oauth(fetch);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;

    let error: DomainError | undefined;
    try {
      await service.exchangeCallback({ code: "authorization-code", state });
    } catch (caught) {
      error = caught as DomainError;
    }
    expect(error).toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    expect(error).toMatchObject({ details: { stage: "token_http" } });
    expect(error?.message).not.toContain(privateValue);
    expect(JSON.stringify(error)).not.toContain(privateValue);
  });

  it("rejects an unusable author identifier instead of storing a credential that cannot post", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "person/unsafe" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const service = oauth(fetch);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;

    await expect(service.exchangeCallback({ code: "authorization-code", state })).rejects.toMatchObject({
      code: "OAUTH_PROVIDER_ERROR",
      details: { stage: "userinfo_identity" }
    });
    expect((await db.oauthTokens.getByProvider("linkedin"))).toBeUndefined();
  });
});
