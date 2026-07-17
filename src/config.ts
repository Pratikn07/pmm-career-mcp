import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional(),
  BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  AUTH_MODE: z.enum(["none", "oauth"]).default("none"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  ALLOWED_SUBJECT: z.string().optional(),
  LINKEDIN_PUBLISH_ENABLED: z.enum(["true", "false"]).default("false"),
  LINKEDIN_VERSION: z.string().default("202606"),
  TOKEN_ENCRYPTION_KEY: z.string().optional()
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  baseUrl: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  authMode: "none" | "oauth";
  oidcIssuer?: string;
  oidcAudience?: string;
  allowedSubject?: string;
  linkedinPublishEnabled: boolean;
  linkedinVersion: string;
  tokenEncryptionKey?: string;
};

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.search !== "" || url.hash !== "") throw new Error("URL must not include a query or fragment");
  return url.toString().replace(/\/+$/, "");
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required in production`);
  return value;
}

function requirePostgresUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL in production");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL in production");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(env);

  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE !== "oauth") {
    throw new Error("AUTH_MODE must be oauth in production");
  }

  if (parsed.NODE_ENV === "production") {
    if (env.DATABASE_PATH !== undefined) throw new Error("DATABASE_PATH is not supported; use DATABASE_URL");
    if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined || env.SUPABASE_SECRET_KEY !== undefined) {
      throw new Error("Supabase service-role keys must not be configured");
    }

    requirePostgresUrl(required(parsed.DATABASE_URL, "DATABASE_URL"));
    const baseUrl = canonicalUrl(parsed.BASE_URL);
    if (new URL(baseUrl).protocol !== "https:") {
      throw new Error("BASE_URL must use HTTPS in production");
    }
    const supabaseUrl = canonicalUrl(required(parsed.SUPABASE_URL, "SUPABASE_URL"));
    if (new URL(supabaseUrl).protocol !== "https:") {
      throw new Error("SUPABASE_URL must use HTTPS in production");
    }
    required(parsed.SUPABASE_PUBLISHABLE_KEY, "SUPABASE_PUBLISHABLE_KEY");

    const issuer = canonicalUrl(required(parsed.OIDC_ISSUER, "OIDC_ISSUER"));
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

  const baseUrl = canonicalUrl(parsed.BASE_URL);
  const supabaseUrl = parsed.SUPABASE_URL === undefined ? undefined : canonicalUrl(parsed.SUPABASE_URL);
  const oidcIssuer = parsed.OIDC_ISSUER === undefined ? undefined : canonicalUrl(parsed.OIDC_ISSUER);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
    baseUrl,
    ...(supabaseUrl === undefined ? {} : { supabaseUrl }),
    ...(parsed.SUPABASE_PUBLISHABLE_KEY === undefined
      ? {}
      : { supabasePublishableKey: parsed.SUPABASE_PUBLISHABLE_KEY }),
    authMode: parsed.AUTH_MODE,
    ...(oidcIssuer === undefined ? {} : { oidcIssuer }),
    ...(parsed.OIDC_AUDIENCE === undefined ? {} : { oidcAudience: parsed.OIDC_AUDIENCE }),
    ...(parsed.ALLOWED_SUBJECT === undefined ? {} : { allowedSubject: parsed.ALLOWED_SUBJECT }),
    linkedinPublishEnabled: parsed.LINKEDIN_PUBLISH_ENABLED === "true",
    linkedinVersion: parsed.LINKEDIN_VERSION,
    ...(parsed.TOKEN_ENCRYPTION_KEY === undefined
      ? {}
      : { tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY })
  };
}
