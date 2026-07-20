import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { RequestAuthContext } from "../auth/request-context.js";
import { SUPABASE_OAUTH_SCOPES } from "../auth/resource-auth.js";
import type { DraftService } from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import type { LinkedInOAuth } from "../linkedin/oauth.js";
import type { PublishService } from "../linkedin/publish-service.js";
import type { MediaPostDraftVersion, PostMediaService } from "../media/post-media-service.js";
import type { PipelineService } from "../pipeline/service.js";
import type { PreviewExpected, PreviewService } from "../posts/preview-service.js";
import {
  explainTargetMatch,
  rankTargetScores,
  scoreTarget,
  type ScoreTargetInput
} from "../ranking/score-target.js";
import type { JobDiscoveryService } from "../research/job-discovery.js";
import type { PeopleDiscoveryService } from "../research/people-discovery.js";
import type { CompanyResult, CompanySearchQuery } from "../research/types.js";
import { describeYcCompanyCoverage } from "../research/yc-provider.js";
import {
  LINKEDIN_REVIEW_CARD_URI,
  registerLinkedInReviewCardResource,
  type LinkedInReviewCardResourceOptions
} from "../review-card/resource.js";
import {
  attachLinkedInPostImagesInput,
  attachLinkedInPostImagesOutput,
  createLinkedInAuthorizationUrlOutput,
  createWeeklyShortlistInput,
  createWeeklyShortlistOutput,
  discoverPublicPeopleInput,
  discoverPublicPeopleOutput,
  draftLinkedInPostInput,
  draftLinkedInPostOutput,
  draftOutreachInput,
  draftOutreachOutput,
  emptyInputSchema,
  explainTargetMatchInput,
  explainTargetMatchOutput,
  findPmmOpportunitiesInput,
  findPmmOpportunitiesOutput,
  getLinkedInConnectionStatusOutput,
  listPipelineInput,
  listPipelineOutput,
  listPostHistoryInput,
  listPostHistoryOutput,
  openLinkedInReviewCardInput,
  openLinkedInReviewCardOutput,
  pipelineStatusSchema,
  previewPostInput,
  previewPostOutput,
  publishLinkedInPostInput,
  publishLinkedInPostOutput,
  rankNetworkingTargetsInput,
  rankNetworkingTargetsOutput,
  recordNoteInput,
  recordNoteOutput,
  revisePostInput,
  revisePostOutput,
  saveTargetInput,
  saveTargetOutput,
  searchYcCompaniesInput,
  searchYcCompaniesOutput,
  setLinkedInPostImagesInput,
  setLinkedInPostImagesOutput,
  updateOutreachStatusInput,
  updateOutreachStatusOutput
} from "./schemas.js";

export const CAREER_MCP_INSTRUCTIONS = "Never fetch LinkedIn for research. Never claim complete employee coverage. Never claim complete YC-company coverage. Scheduled and model-driven flows must stop after saving private drafts and may only open the non-writing review card. Exact preview and publish actions are app-only, never model-callable, and available only after the current user explicitly asks to publish the exact preview. Never batch or retry publishing. Research is restricted to YC companies and allowed public sources. Drafts and pipeline data stay private.";

type YcProvider = { searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]> };
type ConnectionStatus = {
  connected: boolean;
  valid: boolean;
  publishingEnabled: boolean;
  imagePublishingEnabled?: boolean;
};

type ModelMediaService = Pick<PostMediaService, "attachFiles" | "setMedia" | "getVersion"> & {
  createSignedUrls?: (post: MediaPostDraftVersion) => Promise<readonly string[]>;
};

export type CareerMcpDependencies = {
  ycProvider: YcProvider;
  peopleDiscovery: PeopleDiscoveryService;
  jobDiscovery: JobDiscoveryService;
  pipeline: Pick<PipelineService, "saveTarget" | "updateStatus" | "recordNote" | "listPipeline" | "createShortlist">;
  drafts: Pick<DraftService, "createOutreach" | "createPost" | "revisePost" | "getPostHistory">;
  previews: Pick<PreviewService, "create">;
  publish: Pick<PublishService, "publish">;
  linkedin: Pick<LinkedInOAuth, "createAuthorizationUrl">;
  getLinkedInConnectionStatus: () => Promise<ConnectionStatus>;
  media?: ModelMediaService;
};

export type CareerMcpServerOptions = {
  now?: () => Date;
  requestAuthContext?: RequestAuthContext;
  reviewCardResource?: LinkedInReviewCardResourceOptions;
};

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const privateWrite: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const attachmentWrite: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };
const externalWrite: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };
const SUPABASE_OAUTH_SECURITY_SCHEMES = [{ type: "oauth2", scopes: [...SUPABASE_OAUTH_SCOPES] }] as const;
// SDK 1.29 exposes only `_meta` for per-tool extension metadata; its ToolSchema
// does not serialize an untyped top-level `securitySchemes` field.
const oauthToolMetadata: Record<string, unknown> = { securitySchemes: SUPABASE_OAUTH_SECURITY_SCHEMES };
const appOnlyToolMetadata: Record<string, unknown> = {
  ...oauthToolMetadata,
  ui: { visibility: ["app"] }
};
const attachFileToolMetadata: Record<string, unknown> = {
  ...oauthToolMetadata,
  "openai/fileParams": ["images"]
};
const reviewCardLauncherMetadata: Record<string, unknown> = {
  ...oauthToolMetadata,
  "openai/outputTemplate": LINKEDIN_REVIEW_CARD_URI,
  "openai/widgetAccessible": true
};

const MAX_SUMMARY_LENGTH = 240;

function boundedSummary(value: string): string {
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if ([...normalized].length <= MAX_SUMMARY_LENGTH) {
    return normalized;
  }
  return [...normalized].slice(0, MAX_SUMMARY_LENGTH - 1).join("") + "…";
}

function response<T extends Record<string, unknown>>(value: T, summary: string) {
  return {
    content: [{ type: "text" as const, text: boundedSummary(summary) }],
    structuredContent: { data: value }
  };
}

function safeError(error: unknown) {
  const code = error instanceof DomainError ? error.code : "DATA_INTEGRITY";
  return {
    content: [{ type: "text" as const, text: `Operation failed (${code}).` }],
    structuredContent: { data: { error: { code } } },
    isError: true
  };
}

function guarded<T extends Record<string, unknown>>(
  action: () => T | Promise<T>,
  summary: (value: T) => string
) {
  return async () => {
    try {
      const value = await action();
      return response(value, summary(value));
    } catch (error) {
      return safeError(error);
    }
  };
}

function coverageFor(companies: readonly CompanyResult[]) {
  return companies.map((company) => ({
    id: company.id,
    name: company.name,
    checkedAt: company.checkedAt,
    sources: company.sources.map(({ sourceUrl, checkedAt, confidence }) => ({ sourceUrl, checkedAt, confidence })),
    coverage: "authoritative-pages-only" as const
  }));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function scoringNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Ranking clock returned an invalid value", {
      entity: "networking_score"
    });
  }
  return new Date(value.getTime());
}

/** Creates the single-user MCP server. It has no hidden network side effects. */
export function createCareerMcpServer(
  deps: CareerMcpDependencies,
  options: CareerMcpServerOptions = {}
): McpServer {
  const now = options.now ?? (() => new Date());
  const server = new McpServer(
    { name: "pmm-career-mcp", version: "1.0.0" },
    { instructions: CAREER_MCP_INSTRUCTIONS }
  );
  if (options.reviewCardResource !== undefined) {
    registerLinkedInReviewCardResource(server, options.reviewCardResource);
  }

  function authenticatedMedia(): ModelMediaService {
    if (options.requestAuthContext === undefined) {
      throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
    }
    if (deps.media === undefined) {
      throw new DomainError("DATA_INTEGRITY", "Draft media service is unavailable");
    }
    return deps.media;
  }

  server.registerTool("search_yc_companies", {
    title: "Search YC companies",
    description: "Find YC companies from an official, page-scoped public YC source; results are never claimed as complete.",
    inputSchema: searchYcCompaniesInput,
    outputSchema: searchYcCompaniesOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => {
    const query = withoutUndefined(input) as CompanySearchQuery;
    const companies = await deps.ycProvider.searchYcCompanies(query);
    return {
      companies,
      coverage: coverageFor(companies),
      coverageSummary: describeYcCompanyCoverage(query)
    };
  }, ({ companies }) => `Found ${companies.length} YC companies on the selected official page.`)());

  server.registerTool("discover_public_people", {
    title: "Discover public people",
    description: "Find people from allowed public company sources; coverage is best-effort, never complete.",
    inputSchema: discoverPublicPeopleInput,
    outputSchema: discoverPublicPeopleOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async ({ companyId }) => guarded(async () => ({
    ...await deps.peopleDiscovery.discoverPublicPeople(companyId)
  }), ({ people }) => `Found ${people.length} public people from allowed company sources.`)());

  server.registerTool("find_pmm_opportunities", {
    title: "Find PMM opportunities",
    description: "Find PMM and adjacent openings on official public sources.",
    inputSchema: findPmmOpportunitiesInput,
    outputSchema: findPmmOpportunitiesOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async ({ companyIds, preferences }) => guarded(async () => ({
    ...await deps.jobDiscovery.findPmmOpportunities(companyIds, preferences),
    coverage: "authoritative-pages-only" as const
  }), ({ opportunities }) => `Found ${opportunities.length} PMM opportunities on official public sources.`)());

  server.registerTool("rank_networking_targets", {
    title: "Rank networking targets",
    description: "Calculate and rank evidence-backed networking scores on the server.",
    inputSchema: rankNetworkingTargetsInput,
    outputSchema: rankNetworkingTargetsOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async ({ targets }) => guarded(() => {
    const assessedAt = scoringNow(now);
    return {
      targets: rankTargetScores(targets.map((target) => (
        scoreTarget(target as ScoreTargetInput, assessedAt)
      )))
    };
  }, ({ targets: ranked }) => `Ranked ${ranked.length} networking targets using server-calculated scores.`)());

  server.registerTool("explain_target_match", {
    title: "Explain target match",
    description: "Calculate and explain an evidence-backed target score and missing evidence.",
    inputSchema: explainTargetMatchInput,
    outputSchema: explainTargetMatchOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async ({ target }) => guarded(() => {
    const score = scoreTarget(target as ScoreTargetInput, scoringNow(now));
    return { score, ...explainTargetMatch(score) };
  }, ({ score }) => `Calculated a ${score.total.toFixed(1)} networking score with ${score.confidence.toFixed(2)} confidence.`)());

  server.registerTool("draft_outreach", {
    title: "Save outreach draft",
    description: "Save a private outreach draft. It never sends a LinkedIn message or connection request.",
    inputSchema: draftOutreachInput,
    outputSchema: draftOutreachOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => ({
    draft: await deps.drafts.createOutreach(input)
  }), () => "Saved one private outreach draft; nothing was sent.")());

  server.registerTool("draft_linkedin_post", {
    title: "Save LinkedIn post draft",
    description: "Save a private text-post draft; this does not publish.",
    inputSchema: draftLinkedInPostInput,
    outputSchema: draftLinkedInPostOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => ({
    post: await deps.drafts.createPost(input)
  }), () => "Saved one private LinkedIn post draft; nothing was published.")());

  server.registerTool("revise_post", {
    title: "Revise post",
    description: "Create a new immutable private version of a saved post draft.",
    inputSchema: revisePostInput,
    outputSchema: revisePostOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async ({ postId, text }) => guarded(async () => ({
    post: await deps.drafts.revisePost(postId, text)
  }), ({ post }) => `Saved private post version ${post.version}; nothing was published.`)());

  server.registerTool("attach_linkedin_post_images", {
    title: "Attach LinkedIn post images",
    description: "Validate and attach one to four private draft images with alt text, creating a new immutable version. This never previews or publishes.",
    inputSchema: attachLinkedInPostImagesInput,
    outputSchema: attachLinkedInPostImagesOutput,
    annotations: attachmentWrite,
    _meta: attachFileToolMetadata
  }, async (input) => guarded(async () => ({
    post: await authenticatedMedia().attachFiles({
      ...input,
      images: input.images.map(({ download_url, file_id, mime_type, file_name }) => ({
        download_url,
        file_id,
        ...(mime_type === undefined ? {} : { mime_type }),
        ...(file_name === undefined ? {} : { file_name })
      }))
    })
  }), ({ post }) => `Saved ${post.media.length} private draft images in post version ${post.version}; nothing was previewed or published.`)());

  server.registerTool("set_linkedin_post_images", {
    title: "Set LinkedIn post images",
    description: "Replace, remove, reorder, or revise alt text for private draft images, creating a new immutable version. This never previews or publishes.",
    inputSchema: setLinkedInPostImagesInput,
    outputSchema: setLinkedInPostImagesOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => ({
    post: await authenticatedMedia().setMedia(input)
  }), ({ post }) => `Saved ${post.media.length} private draft images in post version ${post.version}; nothing was previewed or published.`)());

  server.registerTool("open_linkedin_review_card", {
    title: "Open LinkedIn review card",
    description: "Open a non-writing review card for one exact private draft version. This does not create a preview capability or publish.",
    inputSchema: openLinkedInReviewCardInput,
    outputSchema: openLinkedInReviewCardOutput,
    annotations: readOnly,
    _meta: reviewCardLauncherMetadata
  }, async ({ postId, version }) => {
    try {
      const media = authenticatedMedia();
      const post = await media.getVersion(postId, version);
      if (post === undefined) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", { entity: "post_draft" });
      }
      const mediaUrls = media.createSignedUrls === undefined
        ? []
        : await media.createSignedUrls(post);
      return {
        ...response({ post }, `Opened private post version ${post.version} for review; no preview or publish action was created.`),
        _meta: { mediaUrls: [...mediaUrls] }
      };
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("preview_post", {
    title: "Preview post",
    description: "Show the exact latest saved post and create a one-use 15-minute preview token; this does not publish.",
    inputSchema: previewPostInput,
    outputSchema: previewPostOutput,
    annotations: privateWrite,
    _meta: appOnlyToolMetadata
  }, async ({ postId, version }) => guarded(async () => ({
    preview: await deps.previews.create(postId, version)
  }), () => "Created an exact one-use post preview valid for 15 minutes; nothing was published.")());

  server.registerTool("create_weekly_shortlist", {
    title: "Create shortlist",
    description: "Save an on-demand private shortlist. It never schedules future work.",
    inputSchema: createWeeklyShortlistInput,
    outputSchema: createWeeklyShortlistOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => ({
    shortlist: await deps.pipeline.createShortlist(input)
  }), ({ shortlist }) => `Saved a private shortlist with ${shortlist.entries.length} targets.`)());

  server.registerTool("save_target", {
    title: "Save target",
    description: "Recalculate and save an evidence-backed networking target in the private pipeline.",
    inputSchema: saveTargetInput,
    outputSchema: saveTargetOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async ({ target }) => guarded(async () => {
    const score = scoreTarget(target as ScoreTargetInput, scoringNow(now));
    return { target: await deps.pipeline.saveTarget(score) };
  }, ({ target: saved }) => `Saved one private networking target with status ${saved.status}.`)());

  server.registerTool("update_outreach_status", {
    title: "Update pipeline status",
    description: "Update a private target's forward-only outreach status.",
    inputSchema: updateOutreachStatusInput,
    outputSchema: updateOutreachStatusOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async ({ targetId, status }) => guarded(async () => ({
    target: await deps.pipeline.updateStatus(targetId, pipelineStatusSchema.parse(status))
  }), ({ target }) => `Updated the private target status to ${target.status}.`)());

  server.registerTool("list_pipeline", {
    title: "List pipeline",
    description: "List private networking targets by optional company or status.",
    inputSchema: listPipelineInput,
    outputSchema: listPipelineOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async (filter) => guarded(async () => ({
    targets: await deps.pipeline.listPipeline(withoutUndefined(filter))
  }), ({ targets }) => `Found ${targets.length} private pipeline targets.`)());

  server.registerTool("record_note", {
    title: "Record private note",
    description: "Save a private note on a networking target.",
    inputSchema: recordNoteInput,
    outputSchema: recordNoteOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async ({ targetId, text }) => guarded(async () => ({
    note: await deps.pipeline.recordNote(targetId, text)
  }), () => "Saved one private target note.")());

  server.registerTool("list_post_history", {
    title: "List post history",
    description: "List immutable private versions of a saved post draft.",
    inputSchema: listPostHistoryInput,
    outputSchema: listPostHistoryOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async ({ postId }) => guarded(async () => ({
    posts: await deps.drafts.getPostHistory(postId)
  }), ({ posts }) => `Found ${posts.length} private post versions.`)());

  server.registerTool("get_linkedin_connection_status", {
    title: "Get LinkedIn connection status",
    description: "Report LinkedIn connection availability without returning credentials.",
    inputSchema: emptyInputSchema,
    outputSchema: getLinkedInConnectionStatusOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async () => guarded(async () => {
    const status = await deps.getLinkedInConnectionStatus();
    return {
      connection: {
        ...status,
        imagePublishingEnabled: status.imagePublishingEnabled ?? false
      }
    };
  }, ({ connection }) => (
    `LinkedIn is ${connection.connected && connection.valid ? "connected" : "not connected"}; text publishing is ${connection.publishingEnabled ? "enabled" : "disabled"}; image publishing is ${connection.imagePublishingEnabled ? "enabled" : "disabled"}.`
  ))());

  server.registerTool("create_linkedin_authorization_url", {
    title: "Create LinkedIn authorization URL",
    description: "Create a short-lived LinkedIn authorization URL. The callback stores tokens server-side.",
    inputSchema: emptyInputSchema,
    outputSchema: createLinkedInAuthorizationUrlOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async () => guarded(() => ({
    authorizationUrl: deps.linkedin.createAuthorizationUrl()
  }), () => "Created a short-lived LinkedIn authorization URL; no post was published.")());

  server.registerTool("publish_linkedin_post", {
    title: "Publish exact LinkedIn post",
    description: "External write: call only when the current user explicitly asks to publish the exact displayed preview. Never batch or retry. Requires an exact fresh one-use preview token.",
    inputSchema: publishLinkedInPostInput,
    outputSchema: publishLinkedInPostOutput,
    annotations: externalWrite,
    _meta: appOnlyToolMetadata
  }, async (input) => guarded(async () => ({
    result: await deps.publish.publish(input as PreviewExpected & { previewToken: string })
  }), ({ result }) => `LinkedIn publish attempt finished with state ${result.state}; it was not retried.`)());

  return server;
}
