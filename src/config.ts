import { z } from "zod";
import { validateDatabaseCaCertificate } from "./db/tls.js";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  AUTH_MODE: z.enum(["none", "oauth"]).default("none"),
  OIDC_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(5_000),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  ALLOWED_SUBJECT: z.string().optional(),
  LINKEDIN_PUBLISH_ENABLED: z.enum(["true", "false"]).default("false"),
  LINKEDIN_IMAGE_PUBLISH_ENABLED: z.enum(["true", "false"]).default("false"),
  LINKEDIN_MEDIA_BUCKET: z.literal("linkedin-draft-media").default("linkedin-draft-media"),
  LINKEDIN_VERSION: z.string().default("202606"),
  TOKEN_ENCRYPTION_KEY: z.string().optional()
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  databaseCaCertificate?: string;
  baseUrl: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  authMode: "none" | "oauth";
  oidcDiscoveryTimeoutMs: number;
  oidcIssuer?: string;
  oidcAudience?: string;
  allowedSubject?: string;
  linkedinPublishEnabled: boolean;
  linkedinImagePublishEnabled: boolean;
  linkedinMediaBucket: "linkedin-draft-media";
  linkedinVersion: string;
  tokenEncryptionKey?: string;
};

function canonicalUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") throw new Error(`${name} must not include credentials`);
  if (url.search !== "" || url.hash !== "") throw new Error(`${name} must not include a query or fragment`);
  return url.toString().replace(/\/+$/, "");
}

function canonicalOrigin(value: string, name: string): string {
  const canonical = canonicalUrl(value, name);
  const url = new URL(canonical);
  if (url.pathname !== "/") throw new Error(`${name} must be an origin without a path`);
  return url.origin;
}

function canonicalSupabaseUrl(value: string, requirePublicProjectOrigin: boolean): string {
  const canonical = canonicalUrl(value, "SUPABASE_URL");
  const url = new URL(canonical);
  if (requirePublicProjectOrigin && (url.protocol !== "https:" || url.port !== "" || url.pathname !== "/" || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname))) {
    throw new Error("SUPABASE_URL must be a Supabase project HTTPS origin");
  }
  return canonical;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required in production`);
  return value;
}

function skipJsonWhitespace(json: string, start: number): number {
  let index = start;
  while (index < json.length && /[\t\n\r ]/.test(json[index]!)) index += 1;
  return index;
}

function readJsonString(json: string, start: number): { end: number; value: string } | undefined {
  if (json[start] !== '"') return undefined;
  for (let index = start + 1; index < json.length; index += 1) {
    const character = json[index]!;
    if (character === "\\") {
      index += 1;
      if (index >= json.length) return undefined;
      continue;
    }
    if (character === '"') {
      const token = json.slice(start, index + 1);
      try {
        const value: unknown = JSON.parse(token);
        return typeof value === "string" ? { end: index + 1, value } : undefined;
      } catch {
        return undefined;
      }
    }
    if (character.charCodeAt(0) <= 0x1f) return undefined;
  }
  return undefined;
}

/** Validates the flat JWT objects Supabase uses and rejects duplicate decoded member names. */
function isUnambiguousFlatJsonObject(json: string): boolean {
  let index = skipJsonWhitespace(json, 0);
  if (json[index] !== "{") return false;
  index = skipJsonWhitespace(json, index + 1);
  if (json[index] === "}") return skipJsonWhitespace(json, index + 1) === json.length;

  const names = new Set<string>();
  while (index < json.length) {
    const member = readJsonString(json, index);
    if (member === undefined || names.has(member.value)) return false;
    names.add(member.value);
    index = skipJsonWhitespace(json, member.end);
    if (json[index] !== ":") return false;
    index = skipJsonWhitespace(json, index + 1);

    if (json[index] === '"') {
      const stringValue = readJsonString(json, index);
      if (stringValue === undefined) return false;
      index = stringValue.end;
    } else {
      const valueStart = index;
      while (index < json.length && !/[\t\n\r ,}]/.test(json[index]!)) index += 1;
      if (valueStart === index) return false;
      try {
        const value: unknown = JSON.parse(json.slice(valueStart, index));
        if (typeof value === "object") return false;
      } catch {
        return false;
      }
    }

    index = skipJsonWhitespace(json, index);
    if (json[index] === ",") {
      index = skipJsonWhitespace(json, index + 1);
      continue;
    }
    if (json[index] === "}") return skipJsonWhitespace(json, index + 1) === json.length;
    return false;
  }
  return false;
}

function decodeUnambiguousLegacyJwtPart(value: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return undefined;
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) return undefined;
    if (!isUnambiguousFlatJsonObject(json)) return undefined;
    const decoded: unknown = JSON.parse(json);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalLegacySignature(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function isLegacyAnonKey(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || !isCanonicalLegacySignature(parts[2]!)) return false;
  const header = decodeUnambiguousLegacyJwtPart(parts[0]!);
  const payload = decodeUnambiguousLegacyJwtPart(parts[1]!);
  if (header?.alg !== "HS256" || header.typ !== "JWT" || payload === undefined) return false;
  return payload.iss === "supabase"
    && typeof payload.ref === "string"
    && /^[a-z0-9]{20}$/.test(payload.ref)
    && payload.role === "anon"
    && typeof payload.iat === "number"
    && Number.isSafeInteger(payload.iat)
    && payload.iat > 0
    && typeof payload.exp === "number"
    && Number.isSafeInteger(payload.exp)
    && payload.exp > payload.iat;
}

function isLoopbackSupabaseOrigin(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(canonicalSupabaseUrl(value, false));
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.pathname === "/"
      && (url.hostname === "127.0.0.1"
        || url.hostname === "localhost"
        || url.hostname === "[::1]"
        || url.hostname === "::1");
  } catch {
    return false;
  }
}

function isLocalCliAnonKey(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || !isCanonicalLegacySignature(parts[2]!)) return false;
  const header = decodeUnambiguousLegacyJwtPart(parts[0]!);
  const payload = decodeUnambiguousLegacyJwtPart(parts[1]!);
  if (header?.alg !== "HS256" || header.typ !== "JWT" || payload === undefined) return false;
  const keys = Object.keys(payload);
  const hasIssuedAt = Object.hasOwn(payload, "iat");
  const validIssuedAt = !hasIssuedAt || (typeof payload.iat === "number"
    && Number.isSafeInteger(payload.iat)
    && payload.iat > 0
    && typeof payload.exp === "number"
    && payload.iat < payload.exp);
  return (keys.length === 3 || keys.length === 4)
    && keys.every((key) => key === "iss" || key === "role" || key === "exp" || key === "iat")
    && payload.iss === "supabase-demo"
    && payload.role === "anon"
    && typeof payload.exp === "number"
    && Number.isSafeInteger(payload.exp)
    && payload.exp >= 1_000_000_000
    && payload.exp <= 4_102_444_800
    && validIssuedAt;
}

function requireBrowserSafeSupabaseKey(
  value: string,
  context: { nodeEnv: "development" | "test" | "production"; supabaseUrl?: string }
): void {
  // Supabase's current self-hosted generator emits a 31-character suffix:
  // 22 URL-safe random characters, an underscore, and an 8-character checksum.
  if (/^sb_publishable_[A-Za-z0-9_-]{31,}$/.test(value)) return;
  if (isLegacyAnonKey(value)) return;
  if (context.nodeEnv !== "production"
    && isLoopbackSupabaseOrigin(context.supabaseUrl)
    && isLocalCliAnonKey(value)) return;
  throw new Error("SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key or a legacy anon JWT");
}

function requirePostgresUrl(value: string, name: "DATABASE_URL" | "MIGRATION_DATABASE_URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL in production`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL in production`);
  }
  // postgres.js can translate arbitrary URL query keys into PostgreSQL startup
  // parameters. Keep this list fail-closed so credentials/routing cannot smuggle
  // `options=-c ...`, role/search_path changes, timeouts, or private GUCs.
  const allowedDatabaseUrlQueryParameters = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase();
    if (!allowedDatabaseUrlQueryParameters.has(normalizedKey)) {
      throw new Error(`${name} contains unsupported query parameter ${normalizedKey}`);
    }
  }
  return url;
}

function requireExplicitDatabaseRole(
  url: URL,
  name: "DATABASE_URL" | "MIGRATION_DATABASE_URL",
  supabaseProjectRef: string
): string {
  if (url.username === "") throw new Error(`${name} must include an explicit database role username`);
  let role: string;
  try {
    role = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${name} must include a valid database role username`);
  }
  const hostname = url.hostname.toLowerCase();
  const directSupabaseMatch = /^db\.([a-z0-9-]+)\.supabase\.co$/.exec(hostname);
  if (directSupabaseMatch !== null && directSupabaseMatch[1] !== supabaseProjectRef) {
    throw new Error(`${name} direct Supabase host must match the SUPABASE_URL project`);
  }
  if (hostname.endsWith(".pooler.supabase.com")) {
    const projectSuffix = `.${supabaseProjectRef}`;
    if (!role.endsWith(projectSuffix) || role.length === projectSuffix.length) {
      throw new Error(`${name} Supabase pooler username must end with .${supabaseProjectRef}`);
    }
    return role.slice(0, -projectSuffix.length);
  }
  return role;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined || env.SUPABASE_SECRET_KEY !== undefined) {
    throw new Error("Supabase service-role keys must not be configured");
  }
  const parsed = environmentSchema.parse(env);
  if (parsed.SUPABASE_PUBLISHABLE_KEY !== undefined) {
    requireBrowserSafeSupabaseKey(parsed.SUPABASE_PUBLISHABLE_KEY, {
      nodeEnv: parsed.NODE_ENV,
      ...(parsed.SUPABASE_URL === undefined ? {} : { supabaseUrl: parsed.SUPABASE_URL })
    });
  }

  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE !== "oauth") {
    throw new Error("AUTH_MODE must be oauth in production");
  }

  if (parsed.NODE_ENV === "production") {
    if (env.DATABASE_PATH !== undefined) throw new Error("DATABASE_PATH is not supported; use DATABASE_URL");

    const supabaseUrl = canonicalSupabaseUrl(required(parsed.SUPABASE_URL, "SUPABASE_URL"), true);
    const supabaseProjectRef = new URL(supabaseUrl).hostname.split(".")[0]!;
    const runtimeDatabase = requirePostgresUrl(required(parsed.DATABASE_URL, "DATABASE_URL"), "DATABASE_URL");
    const migrationDatabase = requirePostgresUrl(
      required(parsed.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL"),
      "MIGRATION_DATABASE_URL"
    );
    validateDatabaseCaCertificate(required(parsed.DATABASE_CA_CERT, "DATABASE_CA_CERT"));
    const runtimeRole = requireExplicitDatabaseRole(runtimeDatabase, "DATABASE_URL", supabaseProjectRef);
    const migrationRole = requireExplicitDatabaseRole(migrationDatabase, "MIGRATION_DATABASE_URL", supabaseProjectRef);
    if (runtimeRole !== "career_mcp_runtime") {
      throw new Error("DATABASE_URL must use the career_mcp_runtime database role");
    }
    if (runtimeRole === migrationRole) {
      throw new Error("MIGRATION_DATABASE_URL must use a different database role from DATABASE_URL");
    }
    const baseUrl = canonicalOrigin(parsed.BASE_URL, "BASE_URL");
    if (new URL(baseUrl).protocol !== "https:") {
      throw new Error("BASE_URL must use HTTPS in production");
    }
    required(parsed.SUPABASE_PUBLISHABLE_KEY, "SUPABASE_PUBLISHABLE_KEY");

    const issuer = canonicalUrl(required(parsed.OIDC_ISSUER, "OIDC_ISSUER"), "OIDC_ISSUER");
    if (new URL(issuer).protocol !== "https:") {
      throw new Error("OIDC_ISSUER must use HTTPS in production");
    }
    const expectedIssuer = `${supabaseUrl}/auth/v1`;
    if (issuer !== expectedIssuer) {
      throw new Error("OIDC_ISSUER must equal SUPABASE_URL/auth/v1 in production");
    }
    if (required(parsed.OIDC_AUDIENCE, "OIDC_AUDIENCE") !== baseUrl) {
      throw new Error("OIDC_AUDIENCE must equal canonical BASE_URL in production");
    }
    const subject = required(parsed.ALLOWED_SUBJECT, "ALLOWED_SUBJECT");
    if (!UUID_PATTERN.test(subject)) {
      throw new Error("ALLOWED_SUBJECT must be a UUID in production");
    }
    if (parsed.TOKEN_ENCRYPTION_KEY === undefined || !/^[0-9a-f]{64}$/i.test(parsed.TOKEN_ENCRYPTION_KEY)) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hexadecimal key in production");
    }
  }

  const baseUrl = canonicalOrigin(parsed.BASE_URL, "BASE_URL");
  const supabaseUrl = parsed.SUPABASE_URL === undefined
    ? undefined
    : canonicalSupabaseUrl(parsed.SUPABASE_URL, parsed.NODE_ENV === "production");
  const oidcIssuer = parsed.OIDC_ISSUER === undefined ? undefined : canonicalUrl(parsed.OIDC_ISSUER, "OIDC_ISSUER");

  const databaseUrl = parsed.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl,
    migrationDatabaseUrl: parsed.MIGRATION_DATABASE_URL ?? databaseUrl,
    ...(parsed.DATABASE_CA_CERT === undefined
      ? {}
      : { databaseCaCertificate: validateDatabaseCaCertificate(parsed.DATABASE_CA_CERT) }),
    baseUrl,
    ...(supabaseUrl === undefined ? {} : { supabaseUrl }),
    ...(parsed.SUPABASE_PUBLISHABLE_KEY === undefined
      ? {}
      : { supabasePublishableKey: parsed.SUPABASE_PUBLISHABLE_KEY }),
    authMode: parsed.AUTH_MODE,
    oidcDiscoveryTimeoutMs: parsed.OIDC_DISCOVERY_TIMEOUT_MS,
    ...(oidcIssuer === undefined ? {} : { oidcIssuer }),
    ...(parsed.OIDC_AUDIENCE === undefined ? {} : { oidcAudience: parsed.OIDC_AUDIENCE }),
    ...(parsed.ALLOWED_SUBJECT === undefined ? {} : { allowedSubject: parsed.ALLOWED_SUBJECT }),
    linkedinPublishEnabled: parsed.LINKEDIN_PUBLISH_ENABLED === "true",
    linkedinImagePublishEnabled: parsed.LINKEDIN_IMAGE_PUBLISH_ENABLED === "true",
    linkedinMediaBucket: parsed.LINKEDIN_MEDIA_BUCKET,
    linkedinVersion: parsed.LINKEDIN_VERSION,
    ...(parsed.TOKEN_ENCRYPTION_KEY === undefined
      ? {}
      : { tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY })
  };
}
