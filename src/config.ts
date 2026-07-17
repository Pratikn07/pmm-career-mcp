import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@127.0.0.1:5432/postgres"),
  BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
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
  authMode: "none" | "oauth";
  oidcIssuer?: string;
  oidcAudience?: string;
  allowedSubject?: string;
  linkedinPublishEnabled: boolean;
  linkedinVersion: string;
  tokenEncryptionKey?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(env);

  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE !== "oauth") {
    throw new Error("AUTH_MODE must be oauth in production");
  }

  if (parsed.NODE_ENV === "production") {
    if (parsed.OIDC_ISSUER === undefined) throw new Error("OIDC_ISSUER is required in production");
    if (new URL(parsed.OIDC_ISSUER).protocol !== "https:") {
      throw new Error("OIDC_ISSUER must use HTTPS in production");
    }
    if (parsed.OIDC_AUDIENCE === undefined) throw new Error("OIDC_AUDIENCE is required in production");
    if (parsed.ALLOWED_SUBJECT === undefined || parsed.ALLOWED_SUBJECT.length === 0) {
      throw new Error("ALLOWED_SUBJECT is required in production");
    }
    if (parsed.TOKEN_ENCRYPTION_KEY === undefined || !/^[0-9a-f]{64}$/i.test(parsed.TOKEN_ENCRYPTION_KEY)) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hexadecimal key in production");
    }
    if (new URL(parsed.BASE_URL).protocol !== "https:") {
      throw new Error("BASE_URL must use HTTPS in production");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: parsed.BASE_URL,
    authMode: parsed.AUTH_MODE,
    ...(parsed.OIDC_ISSUER === undefined ? {} : { oidcIssuer: parsed.OIDC_ISSUER }),
    ...(parsed.OIDC_AUDIENCE === undefined ? {} : { oidcAudience: parsed.OIDC_AUDIENCE }),
    ...(parsed.ALLOWED_SUBJECT === undefined ? {} : { allowedSubject: parsed.ALLOWED_SUBJECT }),
    linkedinPublishEnabled: parsed.LINKEDIN_PUBLISH_ENABLED === "true",
    linkedinVersion: parsed.LINKEDIN_VERSION,
    ...(parsed.TOKEN_ENCRYPTION_KEY === undefined
      ? {}
      : { tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY })
  };
}
