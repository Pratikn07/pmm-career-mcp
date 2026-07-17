import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTVerifyGetKey } from "jose";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  resource_documentation: string;
};

export const SUPABASE_OAUTH_SCOPES = ["openid", "email"] as const;

const oidcMetadataSchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url()
}).strict();

function canonicalBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username !== "" || url.password !== "") {
    throw new Error("OAuth resource URL must not include credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("OAuth resource URL must not include a query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function canonicalAuthorizationServerUrl(issuer: string): string {
  const url = new URL(issuer);
  if (url.username !== "" || url.password !== "") {
    throw new Error("OAuth authorization server URL must not include credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("OAuth authorization server URL must not include a query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function requireOAuthConfig(config: AppConfig): { issuer: string; audience: string; subject: string } {
  if (config.authMode !== "oauth") throw new Error("OAuth resource authentication is not enabled");
  if (config.oidcIssuer === undefined || config.oidcAudience === undefined || config.allowedSubject === undefined) {
    throw new Error("OAuth resource authentication configuration is incomplete");
  }
  const audience = canonicalBaseUrl(config.baseUrl);
  if (config.oidcAudience !== audience) {
    throw new Error("OAuth audience must equal the canonical protected resource URL");
  }
  return { issuer: canonicalAuthorizationServerUrl(config.oidcIssuer), audience, subject: config.allowedSubject };
}

export function protectedResourceMetadata(config: AppConfig): OAuthProtectedResourceMetadata {
  const { issuer } = requireOAuthConfig(config);
  const resource = canonicalBaseUrl(config.baseUrl);
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SUPABASE_OAUTH_SCOPES],
    resource_documentation: `${resource}/docs`
  };
}

function protectedResourceMetadataUrl(config: AppConfig): string {
  return `${canonicalBaseUrl(config.baseUrl)}/.well-known/oauth-protected-resource`;
}

function authenticationChallenge(config: AppConfig): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}" scope="${SUPABASE_OAUTH_SCOPES.join(" ")}"`;
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer[ \t]+([^\s]+)$/i);
  return match?.[1];
}

const noRedirectFetch: FetchImplementation = (url, options) => fetch(url, { ...options, redirect: "error" });

async function jwksFromIssuer(issuer: string, requireHttps: boolean): Promise<JWTVerifyGetKey> {
  const issuerUrl = new URL(issuer);
  if (requireHttps && issuerUrl.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS");
  const discoveryUrl = new URL(".well-known/openid-configuration", `${issuerUrl.toString().replace(/\/+$/, "")}/`);
  const response = await fetch(discoveryUrl, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error("OIDC discovery unavailable");
  const metadata = oidcMetadataSchema.parse(await response.json());
  if (metadata.issuer !== issuer) throw new Error("OIDC issuer mismatch");
  const jwksUrl = new URL(metadata.jwks_uri);
  if (requireHttps && jwksUrl.protocol !== "https:") throw new Error("OIDC JWKS must use HTTPS");
  return createRemoteJWKSet(jwksUrl, { [customFetch]: noRedirectFetch });
}

/**
 * Stateless bearer-token protection for the MCP endpoint. Authentication
 * failures are deliberately indistinguishable to callers and never surface
 * token claims or identity-provider implementation errors.
 */
export function createResourceAuth(config: AppConfig): RequestHandler {
  if (config.authMode === "none") return (_request, _response, next) => next();

  const { issuer, audience, subject } = requireOAuthConfig(config);
  let jwksPromise: Promise<JWTVerifyGetKey> | undefined;
  const keyFor = (): Promise<JWTVerifyGetKey> => {
    jwksPromise ??= jwksFromIssuer(issuer, config.nodeEnv === "production");
    return jwksPromise;
  };

  return async (request, response, next) => {
    const token = bearerToken(request.get("authorization"));
    if (token === undefined) {
      response.setHeader("WWW-Authenticate", authenticationChallenge(config));
      response.status(401).json({ error: "Access to this MCP resource is denied" });
      return;
    }

    try {
      const { payload } = await jwtVerify(token, await keyFor(), { issuer, audience, requiredClaims: ["exp"] });
      if (payload.sub !== subject) {
        response.setHeader("WWW-Authenticate", authenticationChallenge(config));
        response.status(401).json({ error: "Access to this MCP resource is denied" });
        return;
      }
      next();
    } catch {
      response.setHeader("WWW-Authenticate", authenticationChallenge(config));
      response.status(401).json({ error: "Access to this MCP resource is denied" });
    }
  };
}
