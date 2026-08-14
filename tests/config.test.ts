import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const FAKE_PROJECT_REF = "abcdefghijklmnopqrst";
const FAKE_PUBLISHABLE_KEY = `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`;
const FAKE_DATABASE_CA_CERT = "-----BEGIN CERTIFICATE-----\nZmFrZS1jYQ==\n-----END CERTIFICATE-----";

function encodeJwtPart(value: Record<string, unknown> | string): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function legacySupabaseKey(
  role: string,
  options: { header?: Record<string, unknown>; rawPayload?: string; signature?: string } = {}
): string {
  const header = options.header ?? { alg: "HS256", typ: "JWT" };
  const payload = options.rawPayload ?? JSON.stringify({
    iss: "supabase",
    ref: FAKE_PROJECT_REF,
    role,
    iat: 1_700_000_000,
    exp: 2_000_000_000
  });
  const signature = options.signature ?? Buffer.alloc(32, 7).toString("base64url");
  return `${encodeJwtPart(header)}.${encodeJwtPart(payload)}.${signature}`;
}

function localCliAnonKey(rawPayload = `{
  "role": "anon",
  "exp": 2035091493,
  "iss": "supabase-demo"
}`): string {
  return legacySupabaseKey("anon", { rawPayload });
}

// Claim values and formatting mirror the current public Supabase Docker
// `.env.example`; the test uses this suite's fake canonical signature.
const OFFICIAL_DOCKER_ANON_PAYLOAD = "{  \n"
  + "    \"role\": \"anon\",\n"
  + "    \"iss\": \"supabase-demo\",\n"
  + "    \"iat\": 1641769200,\n"
  + "    \"exp\": 1799535600\n"
  + "}";

describe("loadConfig", () => {
  const productionConfig = {
    NODE_ENV: "production" as const,
    AUTH_MODE: "oauth" as const,
    DATABASE_URL: "postgresql://career_mcp_runtime:runtime-password@db.example:5432/postgres",
    MIGRATION_DATABASE_URL: "postgresql://migration_owner:owner-password@db.example:5432/postgres",
    DATABASE_CA_CERT: FAKE_DATABASE_CA_CERT,
    BASE_URL: "https://career.example/",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: FAKE_PUBLISHABLE_KEY,
    OIDC_ISSUER: "https://project.supabase.co/auth/v1",
    OIDC_AUDIENCE: "https://career.example",
    ALLOWED_SUBJECT: "123e4567-e89b-12d3-a456-426614174000",
    TOKEN_ENCRYPTION_KEY: "a".repeat(64)
  };

  it("keeps LinkedIn publishing disabled and uses the private draft bucket by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.linkedinPublishEnabled).toBe(false);
    expect(config.linkedinImagePublishEnabled).toBe(false);
    expect(config.linkedinMediaBucket).toBe("linkedin-draft-media");
  });

  it("rejects invalid LinkedIn image publishing values", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      LINKEDIN_IMAGE_PUBLISH_ENABLED: "yes"
    })).toThrow();
  });

  it("rejects no-auth production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AUTH_MODE: "none",
      TOKEN_ENCRYPTION_KEY: "x".repeat(64)
    })).toThrow(/AUTH_MODE/);
  });

  it.each([
    "DATABASE_URL", "MIGRATION_DATABASE_URL", "DATABASE_CA_CERT", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "OIDC_ISSUER", "OIDC_AUDIENCE", "ALLOWED_SUBJECT", "TOKEN_ENCRYPTION_KEY"
  ])("fails closed in production without %s", (missing) => {
    const values = { ...productionConfig } as Record<string, string>;
    delete values[missing];
    expect(() => loadConfig(values)).toThrow(missing);
  });

  it("allows AUTH_MODE=none only outside production", () => {
    expect(loadConfig({ NODE_ENV: "test", AUTH_MODE: "none" }).authMode).toBe("none");
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "none" })).toThrow(/AUTH_MODE/);
  });

  it("rejects an insecure OIDC issuer in production", () => {
    expect(() => loadConfig({
      ...productionConfig,
      OIDC_ISSUER: "http://project.supabase.co/auth/v1"
    })).toThrow(/OIDC_ISSUER.*HTTPS/);
  });

  it.each([
    ["DATABASE_URL", "mysql://db.example/career", /DATABASE_URL.*PostgreSQL/],
    ["MIGRATION_DATABASE_URL", "mysql://db.example/career", /MIGRATION_DATABASE_URL.*PostgreSQL/],
    ["SUPABASE_URL", "http://project.supabase.co", /SUPABASE_URL.*HTTPS/],
    ["BASE_URL", "https://mcp-user:mcp-password@career.example", /BASE_URL.*credentials/],
    ["SUPABASE_URL", "https://project-user:project-password@project.supabase.co", /SUPABASE_URL.*credentials/],
    ["SUPABASE_URL", "https://project.supabase.co/not-a-project-origin", /SUPABASE_URL.*project HTTPS origin/],
    ["OIDC_ISSUER", "https://other.supabase.co/auth/v1", /OIDC_ISSUER.*SUPABASE_URL/],
    ["OIDC_AUDIENCE", "https://other.example", /OIDC_AUDIENCE.*BASE_URL/],
    ["ALLOWED_SUBJECT", "user-123", /ALLOWED_SUBJECT.*UUID/]
  ])("rejects an invalid production %s", (key, value, expected) => {
    expect(() => loadConfig({ ...productionConfig, [key]: value })).toThrow(expected);
  });

  it("rejects removed DATABASE_PATH configuration in production", () => {
    expect(() => loadConfig({ ...productionConfig, DATABASE_PATH: "./career.db" })).toThrow(/DATABASE_PATH/);
  });

  it.each(["not-a-certificate", "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----"])(
    "rejects a malformed production database CA certificate",
    (databaseCaCertificate) => {
      expect(() => loadConfig({ ...productionConfig, DATABASE_CA_CERT: databaseCaCertificate }))
        .toThrow(/DATABASE_CA_CERT.*certificate/i);
    }
  );

  it("requires separate production migration and runtime database roles", () => {
    expect(() => loadConfig({
      ...productionConfig,
      MIGRATION_DATABASE_URL: productionConfig.DATABASE_URL
    })).toThrow(/MIGRATION_DATABASE_URL.*different.*role/i);

    expect(() => loadConfig({
      ...productionConfig,
      MIGRATION_DATABASE_URL: "postgresql://career_mcp_runtime:different-password@migration.example/postgres"
    })).toThrow(/MIGRATION_DATABASE_URL.*different.*role/i);
  });

  it.each([
    {
      label: "runtime role through the session pooler",
      databaseUrl: "postgresql://career_mcp_runtime.project:runtime-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      migrationDatabaseUrl: "postgresql://postgres:owner-password@db.project.supabase.co:5432/postgres"
    },
    {
      label: "runtime role through the direct endpoint",
      databaseUrl: "postgresql://career_mcp_runtime:runtime-password@db.project.supabase.co:5432/postgres",
      migrationDatabaseUrl: "postgresql://postgres.project:owner-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    }
  ])("normalizes Supabase role aliases for $label", ({ databaseUrl, migrationDatabaseUrl }) => {
    const config = loadConfig({
      ...productionConfig,
      DATABASE_URL: databaseUrl,
      MIGRATION_DATABASE_URL: migrationDatabaseUrl
    });

    expect(config.databaseUrl).toBe(databaseUrl);
    expect(config.migrationDatabaseUrl).toBe(migrationDatabaseUrl);
  });

  it.each([
    "postgresql://postgres:runtime-password@db.project.supabase.co:5432/postgres",
    "postgresql://postgres.project:runtime-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    "postgresql://other_role.project:runtime-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
  ])("requires the production runtime underlying role to be career_mcp_runtime: %s", (databaseUrl) => {
    expect(() => loadConfig({ ...productionConfig, DATABASE_URL: databaseUrl }))
      .toThrow(/DATABASE_URL.*career_mcp_runtime/i);
  });

  it("rejects direct and pooler aliases of the same underlying role", () => {
    expect(() => loadConfig({
      ...productionConfig,
      DATABASE_URL: "postgresql://career_mcp_runtime:runtime-password@db.project.supabase.co:5432/postgres",
      MIGRATION_DATABASE_URL: "postgresql://career_mcp_runtime.project:owner-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    })).toThrow(/MIGRATION_DATABASE_URL.*different.*role/i);
  });

  it.each([
    [
      "DATABASE_URL",
      "postgresql://career_mcp_runtime:runtime-password@db.other-project.supabase.co:5432/postgres"
    ],
    [
      "MIGRATION_DATABASE_URL",
      "postgresql://postgres:owner-password@db.other-project.supabase.co:5432/postgres"
    ]
  ])("rejects a production %s direct host for a different Supabase project", (key, value) => {
    expect(() => loadConfig({ ...productionConfig, [key]: value }))
      .toThrow(new RegExp(`${key}.*SUPABASE_URL|${key}.*project`, "i"));
  });

  it.each([
    ["DATABASE_URL", "statement_timeout"],
    ["DATABASE_URL", "idle_in_transaction_session_timeout"],
    ["DATABASE_URL", "application_name"],
    ["MIGRATION_DATABASE_URL", "statement_timeout"],
    ["MIGRATION_DATABASE_URL", "idle_in_transaction_session_timeout"],
    ["MIGRATION_DATABASE_URL", "application_name"]
  ])("rejects a production %s that overrides %s", (key, parameter) => {
    const value = `${productionConfig[key as "DATABASE_URL" | "MIGRATION_DATABASE_URL"]}?${parameter}=0`;
    expect(() => loadConfig({ ...productionConfig, [key]: value }))
      .toThrow(new RegExp(`${key}.*${parameter}`, "i"));
  });

  it.each([
    [
      "MIGRATION_DATABASE_URL",
      "options=-c%20career_mcp.legacy_post_owner_subject%3D00000000-0000-0000-0000-000000000002",
      "options"
    ],
    ["DATABASE_URL", "OpTiOnS=-c%20search_path%3Dpublic", "options"],
    [
      "MIGRATION_DATABASE_URL",
      "options=-c%20statement_timeout%3D0&OPTIONS=-c%20role%3Dpostgres",
      "options"
    ],
    ["DATABASE_URL", "role=postgres", "role"],
    ["MIGRATION_DATABASE_URL", "search_path=public", "search_path"],
    ["DATABASE_URL", "sslmode=disable", "sslmode"]
  ])(
    "rejects unsupported production %s query parameters: %s",
    (key, query, expectedParameter) => {
      const value = `${productionConfig[key as "DATABASE_URL" | "MIGRATION_DATABASE_URL"]}?${query}`;
      expect(() => loadConfig({ ...productionConfig, [key]: value }))
        .toThrow(new RegExp(`${key}.*${expectedParameter}`, "i"));
    }
  );

  it.each([
    ["DATABASE_URL", "postgresql://db.example/postgres"],
    ["MIGRATION_DATABASE_URL", "postgresql://db.example/postgres"]
  ])("requires an explicit production role in %s", (key, value) => {
    expect(() => loadConfig({ ...productionConfig, [key]: value })).toThrow(new RegExp(`${key}.*username|${key}.*role`, "i"));
  });

  it("returns distinct production migration and runtime database URLs", () => {
    const config = loadConfig(productionConfig);

    expect(config.databaseUrl).toBe(productionConfig.DATABASE_URL);
    expect(config.migrationDatabaseUrl).toBe(productionConfig.MIGRATION_DATABASE_URL);
    expect(config.databaseCaCertificate).toBe(FAKE_DATABASE_CA_CERT);
  });

  it("defaults migration access to the runtime URL only outside production", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl }).migrationDatabaseUrl)
      .toBe(databaseUrl);
  });

  it.each([
    "https://career.example/mcp",
    "https://career.example/nested/path/"
  ])("rejects a BASE_URL with a non-root path: %s", (baseUrl) => {
    expect(() => loadConfig({ NODE_ENV: "test", BASE_URL: baseUrl })).toThrow(/BASE_URL.*origin/);
  });

  it.each([
    FAKE_PUBLISHABLE_KEY,
    legacySupabaseKey("anon")
  ])("accepts a browser-safe Supabase publishable key", (key) => {
    expect(loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: key }).supabasePublishableKey).toBe(key);
  });

  it.each([
    "sb_secret_example",
    "sb_publishable_x",
    `sb_publishable_${"x".repeat(30)}`,
    legacySupabaseKey("service_role"),
    legacySupabaseKey("authenticated"),
    legacySupabaseKey("anon", { header: { alg: "none", typ: "JWT" } }),
    legacySupabaseKey("anon", { header: {} }),
    legacySupabaseKey("anon", {
      rawPayload: `{"iss":"supabase","ref":"${FAKE_PROJECT_REF}","role":"service_role","role":"anon","iat":1700000000,"exp":2000000000}`
    }),
    legacySupabaseKey("anon", {
      rawPayload: `{"iss":"supabase","ref":"${FAKE_PROJECT_REF}","role":"anon","iat":"1700000000","exp":2000000000}`
    }),
    legacySupabaseKey("anon", {
      rawPayload: `{"ref":"${FAKE_PROJECT_REF}","role":"anon","iat":1700000000,"exp":2000000000}`
    }),
    legacySupabaseKey("anon", {
      rawPayload: "{\"iss\":\"supabase\",\"role\":\"anon\",\"iat\":1700000000,\"exp\":2000000000}"
    }),
    legacySupabaseKey("anon", { signature: "not/canonical" }),
    "not-a-supported-key",
    "header.invalid-base64.signature",
    "header.payload",
    ""
  ])("rejects an unsafe or malformed Supabase browser key", (key) => {
    expect(() => loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: key }))
      .toThrow(/SUPABASE_PUBLISHABLE_KEY.*publishable|SUPABASE_PUBLISHABLE_KEY.*anon/);
  });

  it("accepts the current generated opaque-key shape at the 31-character suffix boundary", () => {
    const boundaryKey = `sb_publishable_${"x".repeat(31)}`;
    expect(loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: boundaryKey }).supabasePublishableKey)
      .toBe(boundaryKey);
  });

  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321/",
    "http://[::1]:54321"
  ])("accepts the official formatted CLI local anon profile only with a loopback Supabase origin: %s", (supabaseUrl) => {
    const key = localCliAnonKey();
    expect(loadConfig({
      NODE_ENV: "development",
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: key
    }).supabasePublishableKey).toBe(key);
  });

  it("accepts the exact current public Supabase Docker anon claim profile on loopback", () => {
    const key = localCliAnonKey(OFFICIAL_DOCKER_ANON_PAYLOAD);
    expect(loadConfig({
      NODE_ENV: "development",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: key
    }).supabasePublishableKey).toBe(key);
  });

  it.each([
    { label: "remote URL", env: { NODE_ENV: "test", SUPABASE_URL: "https://project.supabase.co" } },
    { label: "non-loopback IP", env: { NODE_ENV: "test", SUPABASE_URL: "http://127.0.0.2:54321" } },
    { label: "production", env: productionConfig }
  ])("rejects the CLI local anon profile with $label", ({ env }) => {
    expect(() => loadConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: localCliAnonKey() }))
      .toThrow(/SUPABASE_PUBLISHABLE_KEY.*anon/);
  });

  it.each([
    localCliAnonKey(`{"iss":"supabase-demo","role":"service_role","exp":2035091493}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","exp":1}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","iat":"1641769200","exp":1799535600}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","iat":0,"exp":1799535600}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","iat":1799535600,"exp":1799535600}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","iat":1799535601,"exp":1799535600}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","iat":9007199254740992,"exp":1799535600}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"service_role","role":"anon","exp":2035091493}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"service_role","r\\u006fle":"anon","exp":2035091493}`),
    localCliAnonKey(`{"iss":"supabase-demo","role":"anon","exp":2035091493,"ref":"${FAKE_PROJECT_REF}"}`)
  ])("rejects a malformed or ambiguous CLI local anon profile", (key) => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: key
    })).toThrow(/SUPABASE_PUBLISHABLE_KEY.*anon/);
  });

  it("retains strict hosted legacy anon compatibility in production", () => {
    const key = legacySupabaseKey("anon");
    expect(loadConfig({ ...productionConfig, SUPABASE_PUBLISHABLE_KEY: key }).supabasePublishableKey).toBe(key);
  });

  it.each(["development", "test", "production"] as const)("rejects Supabase secret keys in %s", (nodeEnv) => {
    const base = nodeEnv === "production" ? productionConfig : { NODE_ENV: nodeEnv };
    for (const secretName of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"] as const) {
      expect(() => loadConfig({ ...base, [secretName]: "secret-value" })).toThrow(/service-role keys/);
    }
  });

  it.each(["development", "test"] as const)("allows a local Supabase URL in %s", (nodeEnv) => {
    expect(loadConfig({
      NODE_ENV: nodeEnv,
      SUPABASE_URL: "http://127.0.0.1:54321/"
    }).supabaseUrl).toBe("http://127.0.0.1:54321");
  });

  it("normalizes the canonical public URLs for OAuth configuration", () => {
    const config = loadConfig(productionConfig);
    expect(config.baseUrl).toBe("https://career.example");
    expect(config.supabaseUrl).toBe("https://project.supabase.co");
    expect(config.oidcAudience).toBe(config.baseUrl);
    expect(config.oidcIssuer).toBe("https://project.supabase.co/auth/v1");
  });
});
