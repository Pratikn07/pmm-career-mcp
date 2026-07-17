import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/career-mcp.sqlite"),
  BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  AUTH_MODE: z.enum(["none", "oauth"]).default("none"),
  ALLOWED_SUBJECT: z.string().optional(),
  LINKEDIN_PUBLISH_ENABLED: z.enum(["true", "false"]).default("false"),
  LINKEDIN_VERSION: z.string().default("202606"),
  TOKEN_ENCRYPTION_KEY: z.string().optional()
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databasePath: string;
  baseUrl: string;
  authMode: "none" | "oauth";
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

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    baseUrl: parsed.BASE_URL,
    authMode: parsed.AUTH_MODE,
    ...(parsed.ALLOWED_SUBJECT === undefined ? {} : { allowedSubject: parsed.ALLOWED_SUBJECT }),
    linkedinPublishEnabled: parsed.LINKEDIN_PUBLISH_ENABLED === "true",
    linkedinVersion: parsed.LINKEDIN_VERSION,
    ...(parsed.TOKEN_ENCRYPTION_KEY === undefined
      ? {}
      : { tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY })
  };
}
