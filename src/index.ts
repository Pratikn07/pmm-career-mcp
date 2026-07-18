import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type { Server } from "node:http";
import { loadConfig, type AppConfig } from "./config.js";
import {
  createDatabase,
  type CareerDatabase,
  type DatabaseConnectionOptions
} from "./db/client.js";
import { DomainError } from "./domain/errors.js";
import { createDraftService } from "./drafts/service.js";
import { createHttpApp } from "./http/app.js";
import { createLinkedInOAuth, type LinkedInOAuth } from "./linkedin/oauth.js";
import { createLinkedInPostsClient } from "./linkedin/posts-client.js";
import type { LinkedInPostsClient } from "./linkedin/publish-service.js";
import { createPublishService } from "./linkedin/publish-service.js";
import { createCareerMcpServer } from "./mcp/server.js";
import { createPipelineService } from "./pipeline/service.js";
import { createPreviewService } from "./posts/preview-service.js";
import { createJobDiscovery } from "./research/job-discovery.js";
import { createPeopleDiscovery } from "./research/people-discovery.js";
import type { DiscoveryAdapterOptions } from "./research/discovery-deadline.js";
import type { FetchedPage } from "./research/fetch-page.js";
import type { CompanyResult, CompanySearchQuery } from "./research/types.js";
import { createPublicYcSource, createYcProvider, type YcSource } from "./research/yc-provider.js";

type FetchPage = (url: string, options: DiscoveryAdapterOptions) => Promise<FetchedPage>;
type ResolveAddresses = (hostname: string, options: DiscoveryAdapterOptions) => Promise<string[]>;

type ApplicationOptions = {
  config: AppConfig;
  database?: CareerDatabase;
  ycSource?: YcSource;
  fetchPage?: FetchPage;
  resolveAddresses?: ResolveAddresses;
  now?: () => Date;
  linkedinClient?: LinkedInPostsClient;
  linkedinOAuth?: Pick<LinkedInOAuth, "createAuthorizationUrl" | "exchangeCallback">;
};

export type CareerApplication = {
  app: Express;
  database: CareerDatabase;
};

function unavailableLinkedInClient(): LinkedInPostsClient {
  return {
    async createTextPost() {
      throw new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization must be reconnected");
    }
  };
}

function unavailableLinkedInOAuth(): Pick<LinkedInOAuth, "createAuthorizationUrl" | "exchangeCallback"> {
  const unavailable = () => {
    throw new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization is not configured");
  };
  return { createAuthorizationUrl: unavailable, exchangeCallback: async () => unavailable() };
}

function persistedYcProvider(
  database: CareerDatabase,
  source: YcSource,
  now: () => Date
): { searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]> } {
  const provider = createYcProvider(source, { now });
  return {
    async searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]> {
      const imported = await provider.searchYcCompanies(query);
      return await Promise.all(imported.map(async (company) => {
        const stored = await database.companies.upsert({
          ycId: company.ycId,
          name: company.name,
          ...(company.batch === undefined ? {} : { batch: company.batch }),
          ...(company.status === undefined ? {} : { status: company.status }),
          ...(company.location === undefined ? {} : { location: company.location }),
          ...(company.industry === undefined ? {} : { industry: company.industry }),
          ...(company.hiring === undefined ? {} : { isHiring: company.hiring }),
          ...(company.websiteUrl === undefined ? {} : { websiteUrl: company.websiteUrl }),
          ...(company.sources[0] === undefined ? {} : { ycUrl: company.sources[0].sourceUrl }),
          checkedAt: company.checkedAt
        });
        return { ...company, id: stored.id };
      }));
    }
  };
}

function oauthFromEnvironment(
  database: CareerDatabase,
  config: AppConfig,
  env: NodeJS.ProcessEnv
): Pick<LinkedInOAuth, "createAuthorizationUrl" | "exchangeCallback"> {
  const clientId = env.LINKEDIN_CLIENT_ID;
  const clientSecret = env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = env.LINKEDIN_REDIRECT_URI;
  if (
    config.tokenEncryptionKey === undefined
    || clientId === undefined
    || clientSecret === undefined
    || redirectUri === undefined
  ) {
    return unavailableLinkedInOAuth();
  }
  return createLinkedInOAuth(database, {
    clientId,
    clientSecret,
    redirectUri,
    tokenEncryptionKey: config.tokenEncryptionKey
  });
}

/**
 * Composes the production server and also provides an injection seam for the
 * offline end-to-end test. No service is contacted until its MCP tool is called.
 */
export async function createCareerApplication(
  options: ApplicationOptions
): Promise<CareerApplication> {
  const database = options.database ?? await createDatabase(options.config.databaseUrl, {
    migrationDatabaseUrl: options.config.migrationDatabaseUrl,
    requireTls: options.config.nodeEnv === "production"
  });
  const now = options.now ?? (() => new Date());
  const ycProvider = persistedYcProvider(database, options.ycSource ?? createPublicYcSource(), now);
  const peopleDiscovery = createPeopleDiscovery({
    repositories: database,
    ...(options.fetchPage === undefined ? {} : { fetchPage: options.fetchPage }),
    now
  });
  const jobDiscovery = createJobDiscovery({
    repositories: database,
    ...(options.fetchPage === undefined ? {} : { fetchPage: options.fetchPage }),
    ...(options.resolveAddresses === undefined ? {} : { resolveAddresses: options.resolveAddresses }),
    now
  });
  const pipeline = createPipelineService(database);
  const drafts = createDraftService(database);
  const previews = createPreviewService(database, { clock: now });
  const client = options.linkedinClient ?? (options.config.tokenEncryptionKey === undefined
    ? unavailableLinkedInClient()
    : createLinkedInPostsClient(database, {
      tokenEncryptionKey: options.config.tokenEncryptionKey,
      linkedinVersion: options.config.linkedinVersion
    }));
  const publish = createPublishService(database, {
    previewService: previews,
    client,
    publishEnabled: options.config.linkedinPublishEnabled,
    clock: now
  });
  const linkedin = options.linkedinOAuth ?? unavailableLinkedInOAuth();
  const app = createHttpApp({
    config: options.config,
    checkReady: () => database.checkReady(),
    mcpServerFactory: () => createCareerMcpServer({
      ycProvider,
      peopleDiscovery,
      jobDiscovery,
      pipeline,
      drafts,
      previews,
      publish,
      linkedin,
      getLinkedInConnectionStatus: async () => {
        const token = await database.oauthTokens.getByProvider("linkedin");
        return {
          connected: token !== undefined,
          valid: token !== undefined && (token.expiresAt === null || Date.parse(token.expiresAt) > now().getTime()),
          publishingEnabled: options.config.linkedinPublishEnabled
        };
      }
    }, { now })
  });
  app.get("/linkedin/callback", async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (code === undefined || state === undefined) {
      response.status(400).send("LinkedIn authorization could not be completed.");
      return;
    }
    try {
      await linkedin.exchangeCallback({ code, state });
      response.status(200).send("LinkedIn is connected. You can close this window.");
    } catch {
      response.status(400).send("LinkedIn authorization could not be completed.");
    }
  });
  return { app, database };
}

export type StartServerDependencies = {
  createDatabase?: (
    databaseUrl: string,
    options: DatabaseConnectionOptions
  ) => Promise<CareerDatabase>;
};

export type RunningCareerApplication = CareerApplication & {
  server: Server;
  close(): Promise<void>;
};

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: StartServerDependencies = {}
): Promise<RunningCareerApplication> {
  const config = loadConfig(env);
  const database = await (dependencies.createDatabase ?? createDatabase)(config.databaseUrl, {
    migrationDatabaseUrl: config.migrationDatabaseUrl,
    requireTls: config.nodeEnv === "production"
  });
  let runtime: CareerApplication;
  try {
    // createDatabase applies migrations. Probe before listening so a process
    // only receives traffic after the migrated database is usable.
    await database.checkReady();
    const linkedin = oauthFromEnvironment(database, config, env);
    runtime = await createCareerApplication({ config, database, linkedinOAuth: linkedin });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  const server = runtime.app.listen(config.port);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close(async (httpError) => {
        let databaseError: unknown;
        try {
          await runtime.database.close();
        } catch (error) {
          databaseError = error;
        }
        if (httpError !== undefined) {
          reject(httpError);
        } else if (databaseError !== undefined) {
          reject(databaseError);
        } else {
          resolve();
        }
      });
    });
    return closing;
  };
  const handleSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, handleSignal);
  return { ...runtime, server, close };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startServer().catch(() => {
    process.exitCode = 1;
  });
}
