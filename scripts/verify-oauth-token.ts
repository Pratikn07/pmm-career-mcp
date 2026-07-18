import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { hasExactSupabaseOAuthScopes } from "../src/auth/scopes.js";

export type OAuthTokenExpectations = {
  issuer: string;
  audience: string;
  subject: string;
};

function tokenFailure(): Error {
  return new Error("OAuth token verification failed");
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw tokenFailure();
  }
  return url.toString().replace(/\/+$/, "");
}

export function oauthTokenExpectations(env: NodeJS.ProcessEnv): OAuthTokenExpectations {
  try {
    const issuer = canonicalUrl(required(env.OIDC_ISSUER));
    const audience = canonicalUrl(required(env.BASE_URL));
    const subject = required(env.ALLOWED_SUBJECT);
    return { issuer, audience, subject };
  } catch {
    throw tokenFailure();
  }
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) throw tokenFailure();
  return value;
}

/** Reads from an inherited pipe only; interactive terminal input could echo a JWT. */
export async function readOAuthAccessToken(
  env: NodeJS.ProcessEnv,
  input: AsyncIterable<string | Buffer> = process.stdin
): Promise<string> {
  const environmentToken = env.OAUTH_ACCESS_TOKEN;
  if (environmentToken !== undefined && environmentToken.trim().length > 0) return environmentToken.trim();
  if (process.stdin.isTTY && input === process.stdin) throw tokenFailure();

  let token = "";
  for await (const chunk of input) {
    token += chunk.toString();
    if (token.length > 16_384) throw tokenFailure();
  }
  if (token.trim().length === 0) throw tokenFailure();
  return token.trim();
}

/** Ensures the JWT's verified claims exactly match the configured resource. */
export function validateVerifiedTokenClaims(payload: JWTPayload, expected: OAuthTokenExpectations): void {
  const now = Math.floor(Date.now() / 1_000);
  if (
    payload.iss !== expected.issuer
    || payload.aud !== expected.audience
    || payload.sub !== expected.subject
    || typeof payload.exp !== "number"
    || payload.exp <= now
    || !hasExactSupabaseOAuthScopes(payload.scope)
  ) {
    throw tokenFailure();
  }
}

export async function verifyOAuthAccessToken(token: string, expected: OAuthTokenExpectations): Promise<void> {
  try {
    const jwks = createRemoteJWKSet(new URL(`${expected.issuer}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expected.issuer,
      audience: expected.audience,
      requiredClaims: ["exp", "sub", "scope"]
    });
    validateVerifiedTokenClaims(payload, expected);
  } catch {
    throw tokenFailure();
  }
}

async function main(): Promise<void> {
  try {
    const expected = oauthTokenExpectations(process.env);
    const token = await readOAuthAccessToken(process.env);
    await verifyOAuthAccessToken(token, expected);
    process.stdout.write("OAuth token accepted for the configured issuer, audience, subject, and exact resource scopes.\n");
  } catch {
    process.stderr.write("OAuth token verification failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
