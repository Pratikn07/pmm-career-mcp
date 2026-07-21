import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type { Server } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestAuthContext } from "./auth/request-context.js";
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
import { loadLinkedInCredential } from "./linkedin/posts-client.js";
import {
  createLinkedInPublishingClient,
  type LinkedInPublishingClient
} from "./linkedin/publishing-client.js";
import { createImagePublishService } from "./linkedin/image-publish-service.js";
import { downloadOpenAiFile } from "./media/file-download.js";
import { inspectLinkedInImage } from "./media/image-inspection.js";
import { createPostMediaService } from "./media/post-media-service.js";
import {
  createSupabaseDraftMediaStorage,
  type DraftMediaStorage
} from "./media/storage.js";
import { createCareerMcpServer } from "./mcp/server.js";
import { createPipelineService } from "./pipeline/service.js";
import { createPreviewService } from "./posts/preview-service.js";
import { createReviewService } from "./posts/review-service.js";
import { createJobDiscovery } from "./research/job-discovery.js";
import { createPeopleDiscovery } from "./research/people-discovery.js";
import type { DiscoveryAdapterOptions } from "./research/discovery-deadline.js";
import type { FetchedPage } from "./research/fetch-page.js";
import type { CompanyResult, CompanySearchQuery } from "./research/types.js";
import { createPublicYcSource, createYcProvider, type YcSource } from "./research/yc-provider.js";

type FetchPage = (url: string, options: DiscoveryAdapterOptions) => Promise<FetchedPage>;
type ResolveAddresses = (hostname: string, options: DiscoveryAdapterOptions) => Promise<string[]>;

type MediaStorageFactory = (
  config: AppConfig,
  context: RequestAuthContext
) => DraftMediaStorage;

type ApplicationOptions = {
  config: AppConfig;
  database?: CareerDatabase;
  ycSource?: YcSource;
  fetchPage?: FetchPage;
  resolveAddresses?: ResolveAddresses;
  now?: () => Date;
  linkedinPublishingClient?: LinkedInPublishingClient;
  linkedinOAuth?: Pick<LinkedInOAuth, "createAuthorizationUrl" | "exchangeCallback">;
  mediaStorageFactory?: MediaStorageFactory;
  mediaDownloadFile?: typeof downloadOpenAiFile;
  mediaInspectImage?: typeof inspectLinkedInImage;
};

export type CareerApplication = {
  app: Express;
  database: CareerDatabase;
  /** Builds the same request-scoped server used by the stateless HTTP route. */
  createMcpServer(context: RequestAuthContext | undefined): McpServer;
};

export function createLinkedInConnectionPreflight(
  database: CareerDatabase,
  options: Readonly<{
    tokenEncryptionKey?: string;
    publishingClientAvailable: boolean;
  }>
): () => Promise<boolean> {
  return async () => {
    if (!options.publishingClientAvailable || options.tokenEncryptionKey === undefined) {
      return false;
    }
    try {
      await loadLinkedInCredential(database, options.tokenEncryptionKey);
      return true;
    } catch {
      return false;
    }
  };
}

function unavailableLinkedInClient(): LinkedInPublishingClient {
  const unavailable = (): never => {
    throw new DomainError("OAUTH_PROVIDER_ERROR", "LinkedIn authorization is not configured");
  };
  return {
    async initializeImage() { return unavailable(); },
    async uploadImage() { return unavailable(); },
    async createPost() { return unavailable(); }
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

function hasPrivateMediaConfiguration(config: AppConfig): boolean {
  if (
    config.supabaseUrl === undefined
    || config.supabasePublishableKey === undefined
    || config.supabasePublishableKey.length === 0
  ) return false;
  try {
    const url = new URL(config.supabaseUrl);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === config.supabaseUrl;
  } catch {
    return false;
  }
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
    requireTls: options.config.nodeEnv === "production",
    ...(options.config.databaseCaCertificate === undefined
      ? {}
      : { tlsCaCertificate: options.config.databaseCaCertificate })
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
  const client = options.linkedinPublishingClient ?? (options.config.tokenEncryptionKey === undefined
    ? unavailableLinkedInClient()
    : createLinkedInPublishingClient(database, {
      tokenEncryptionKey: options.config.tokenEncryptionKey,
      linkedinVersion: options.config.linkedinVersion
    }));
  const linkedin = options.linkedinOAuth ?? unavailableLinkedInOAuth();
  const mediaStorageFactory = options.mediaStorageFactory ?? createSupabaseDraftMediaStorage;
  const createMcpServer = (context: RequestAuthContext | undefined): McpServer => {
    const connectionValid = createLinkedInConnectionPreflight(database, {
      ...(options.config.tokenEncryptionKey === undefined
        ? {}
        : { tokenEncryptionKey: options.config.tokenEncryptionKey }),
      publishingClientAvailable: options.linkedinPublishingClient !== undefined
        || options.config.tokenEncryptionKey !== undefined
    });
    let media;
    let reviews;
    let publish;
    if (context !== undefined && hasPrivateMediaConfiguration(options.config)) {
      try {
        const storage = mediaStorageFactory(options.config, context);
        media = createPostMediaService(database, {
          subject: context.subject,
          storage,
          ...(options.mediaDownloadFile === undefined
            ? {}
            : { downloadFile: options.mediaDownloadFile }),
          ...(options.mediaInspectImage === undefined
            ? {}
            : { inspectImage: options.mediaInspectImage })
        });
        reviews = createReviewService(database, {
          subject: context.subject,
          storage,
          clock: now
        });
        publish = createImagePublishService(database, {
          subject: context.subject,
          storage,
          client,
          publishEnabled: options.config.linkedinPublishEnabled,
          imagePublishEnabled: options.config.linkedinImagePublishEnabled,
          connectionValid,
          clock: now
        });
      } catch {
        // Authenticated tools return only safe unavailable errors when private
        // Storage cannot be composed; request credentials are never retained.
      }
    }
    const publisher = publish ?? {
      async publish(): Promise<never> {
        if (context === undefined) {
          throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
        }
        throw new DomainError("MEDIA_STORAGE_ERROR", "Draft media storage is unavailable");
      }
    };
    return createCareerMcpServer({
      ycProvider,
      peopleDiscovery,
      jobDiscovery,
      pipeline,
      drafts,
      previews,
      ...(reviews === undefined ? {} : { reviews }),
      ...(media === undefined ? {} : { media }),
      publish: publisher,
      linkedin,
      getLinkedInConnectionStatus: async () => {
        const token = await database.oauthTokens.getByProvider("linkedin");
        return {
          connected: token !== undefined,
          valid: token !== undefined && await connectionValid(),
          publishingEnabled: options.config.linkedinPublishEnabled,
          imagePublishingEnabled: options.config.linkedinImagePublishEnabled
        };
      }
    }, {
      now,
      ...(context === undefined ? {} : { requestAuthContext: context }),
      ...(options.config.supabaseUrl === undefined
        ? {}
        : {
            reviewCardResource: {
              baseUrl: options.config.baseUrl,
              supabaseUrl: options.config.supabaseUrl
            }
          })
    });
  };
  const app = createHttpApp({
    config: options.config,
    checkReady: () => database.checkReady(),
    mcpServerFactory: createMcpServer
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
  return { app, database, createMcpServer };
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
    requireTls: config.nodeEnv === "production",
    ...(config.databaseCaCertificate === undefined
      ? {}
      : { tlsCaCertificate: config.databaseCaCertificate })
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
