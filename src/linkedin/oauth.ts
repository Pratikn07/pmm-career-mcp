import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import { DomainError } from "../domain/errors.js";
import { encryptJson } from "../security/crypto.js";

const AUTHORIZATION_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const REQUIRED_SCOPES = Object.freeze(["openid", "profile", "w_member_social"]);

type PendingState = Readonly<{ codeVerifier: string; expiresAt: number }>;

export type LinkedInOAuthDependencies = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

export type OAuthCallbackInput = Readonly<{ code: string; state: string }>;

function providerError(): DomainError {
  return new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization could not be completed");
}

function stateError(): DomainError {
  return new DomainError("OAUTH_STATE_INVALID", "LinkedIn authorization state is invalid or expired");
}

function configurationError(): DomainError {
  return new DomainError("VALIDATION_ERROR", "LinkedIn OAuth configuration is invalid");
}

function nonEmptyString(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function currentTime(clock: () => Date): number {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "OAuth clock returned an invalid value");
  }
  return value.getTime();
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Server-side LinkedIn OAuth. Pending state is deliberately in-memory: it is
 * short-lived, single-use, and never persisted. It appears only as the OAuth
 * authorization URL parameter required for the browser redirect flow.
 */
export function createLinkedInOAuth(database: CareerDatabase, dependencies: LinkedInOAuthDependencies) {
  if (
    !nonEmptyString(dependencies.clientId, 512)
    || !nonEmptyString(dependencies.clientSecret, 4_096)
    || !nonEmptyString(dependencies.redirectUri, 4_096)
  ) {
    throw configurationError();
  }
  try {
    const parsed = new URL(dependencies.redirectUri);
    if (parsed.protocol !== "https:") {
      throw configurationError();
    }
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw configurationError();
  }

  const fetch = dependencies.fetch ?? globalThis.fetch;
  const clock = dependencies.clock ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const pendingStates = new Map<string, PendingState>();

  function createAuthorizationUrl(): string {
    const now = currentTime(clock);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)) {
      throw new DomainError("DATA_INTEGRITY", "OAuth random source returned an invalid value");
    }
    const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
    pendingStates.set(state, { codeVerifier, expiresAt: now + OAUTH_STATE_TTL_MS });

    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", dependencies.clientId);
    url.searchParams.set("redirect_uri", dependencies.redirectUri);
    url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }

  async function exchangeCallback(input: OAuthCallbackInput): Promise<{ connected: true }> {
    if (!nonEmptyString(input?.code, 4_096) || !nonEmptyString(input?.state, 256)) {
      throw stateError();
    }
    const pending = pendingStates.get(input.state);
    // Consume before the network operation so a failed exchange cannot be replayed.
    pendingStates.delete(input.state);
    if (pending === undefined || pending.expiresAt <= currentTime(clock)) {
      throw stateError();
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: dependencies.redirectUri,
          client_id: dependencies.clientId,
          client_secret: dependencies.clientSecret,
          code_verifier: pending.codeVerifier
        }).toString()
      });
    } catch {
      throw providerError();
    }
    if (!tokenResponse.ok) {
      throw providerError();
    }
    const token = await jsonObject(tokenResponse);
    if (token === undefined || !nonEmptyString(token.access_token)) {
      throw providerError();
    }
    const expiresIn = token.expires_in;
    if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw providerError();
    }

    let identityResponse: Response;
    try {
      identityResponse = await fetch(USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
    } catch {
      throw providerError();
    }
    if (!identityResponse.ok) {
      throw providerError();
    }
    const identity = await jsonObject(identityResponse);
    if (
      identity === undefined
      || !nonEmptyString(identity.sub, 512)
      || !/^[A-Za-z0-9_-]+$/.test(identity.sub)
    ) {
      throw providerError();
    }

    const authorUrn = `urn:li:person:${identity.sub}`;
    const refreshToken = nonEmptyString(token.refresh_token) ? token.refresh_token : undefined;
    const expiresAt = new Date(currentTime(clock) + expiresIn * 1_000).toISOString();
    try {
      await database.oauthTokens.upsert({
        provider: "linkedin",
        ciphertext: JSON.stringify(encryptJson({
          accessToken: token.access_token,
          authorUrn
        }, dependencies.tokenEncryptionKey)),
        ...(refreshToken === undefined
          ? {}
          : { refreshMetadataCiphertext: JSON.stringify(encryptJson({ refreshToken }, dependencies.tokenEncryptionKey)) }),
        expiresAt
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError("DATA_INTEGRITY", "LinkedIn authorization could not be stored");
    }
    return { connected: true };
  }

  return { createAuthorizationUrl, exchangeCallback };
}

export type LinkedInOAuth = ReturnType<typeof createLinkedInOAuth>;
