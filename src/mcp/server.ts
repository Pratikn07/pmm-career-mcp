import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { DraftService } from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import type { LinkedInOAuth } from "../linkedin/oauth.js";
import type { PublishService } from "../linkedin/publish-service.js";
import type { PipelineService } from "../pipeline/service.js";
import type { PreviewService } from "../posts/preview-service.js";
import { explainTargetMatch, rankTargetScores, type TargetScore } from "../ranking/score-target.js";
import type { JobDiscoveryService } from "../research/job-discovery.js";
import type { PeopleDiscoveryService } from "../research/people-discovery.js";
import type { CompanyResult, CompanySearchQuery } from "../research/types.js";
import type { PreviewExpected } from "../posts/preview-service.js";
import {
  createWeeklyShortlistInput,
  discoverPublicPeopleInput,
  draftLinkedInPostInput,
  draftOutreachInput,
  explainTargetMatchInput,
  emptyInputSchema,
  findPmmOpportunitiesInput,
  listPipelineInput,
  listPostHistoryInput,
  pipelineStatusSchema,
  previewPostInput,
  publishLinkedInPostInput,
  rankNetworkingTargetsInput,
  recordNoteInput,
  revisePostInput,
  saveTargetInput,
  searchYcCompaniesInput,
  toolOutputSchema,
  updateOutreachStatusInput
} from "./schemas.js";

export const CAREER_MCP_INSTRUCTIONS = "Never fetch LinkedIn for research. Never claim complete employee coverage. Never call publish_linkedin_post unless the current user explicitly asks to publish the exact preview. Never batch or retry publishing. Research is restricted to YC companies and allowed public sources. Drafts and pipeline data stay private. Publishing is text-only and requires the exact saved version, checksum, visibility, and fresh one-use preview token.";

type YcProvider = { searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]> };
type ConnectionStatus = { connected: boolean; valid: boolean; publishingEnabled: boolean };

export type CareerMcpDependencies = {
  ycProvider: YcProvider;
  peopleDiscovery: PeopleDiscoveryService;
  jobDiscovery: JobDiscoveryService;
  pipeline: Pick<PipelineService, "saveTarget" | "updateStatus" | "recordNote" | "listPipeline" | "createShortlist">;
  drafts: Pick<DraftService, "createOutreach" | "createPost" | "revisePost" | "getPostHistory">;
  previews: Pick<PreviewService, "create">;
  publish: Pick<PublishService, "publish">;
  linkedin: Pick<LinkedInOAuth, "createAuthorizationUrl">;
  getLinkedInConnectionStatus: () => ConnectionStatus;
};

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const privateWrite: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const externalWrite: ToolAnnotations = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };

function response(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: "Done." }], structuredContent: { data: value } };
}

function safeError(error: unknown) {
  const code = error instanceof DomainError ? error.code : "DATA_INTEGRITY";
  const message = error instanceof DomainError ? error.message : "The requested operation could not be completed";
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { data: { error: { code } } },
    isError: true
  };
}

function guarded<T extends Record<string, unknown>>(action: () => T | Promise<T>) {
  return async () => {
    try {
      return response(await action());
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
    coverage: "authoritative-pages-only"
  }));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** Creates the single-user MCP server. It has no hidden network side effects. */
export function createCareerMcpServer(deps: CareerMcpDependencies): McpServer {
  const server = new McpServer({ name: "pmm-career-mcp", version: "1.0.0" }, { instructions: CAREER_MCP_INSTRUCTIONS });

  server.registerTool("search_yc_companies", { title: "Search YC companies", description: "Find YC companies from public YC sources.", inputSchema: searchYcCompaniesInput, outputSchema: toolOutputSchema, annotations: readOnly }, async (input) => guarded(async () => {
    const companies = await deps.ycProvider.searchYcCompanies(
      withoutUndefined(input) as CompanySearchQuery
    );
    return { companies, coverage: coverageFor(companies) };
  })());
  server.registerTool("discover_public_people", { title: "Discover public people", description: "Find people from allowed public company sources; coverage is best-effort, never complete.", inputSchema: discoverPublicPeopleInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ companyId }) => guarded(async () => ({ ...await deps.peopleDiscovery.discoverPublicPeople(companyId) }))());
  server.registerTool("find_pmm_opportunities", { title: "Find PMM opportunities", description: "Find PMM and adjacent openings on official public sources.", inputSchema: findPmmOpportunitiesInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ companyIds, preferences }) => guarded(async () => ({ ...await deps.jobDiscovery.findPmmOpportunities(companyIds, preferences), coverage: "authoritative-pages-only" }))());
  server.registerTool("rank_networking_targets", { title: "Rank networking targets", description: "Sort supplied evidence-backed target scores transparently.", inputSchema: rankNetworkingTargetsInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ scores }) => guarded(() => ({ targets: rankTargetScores(scores as TargetScore[]) }))());
  server.registerTool("explain_target_match", { title: "Explain target match", description: "Explain an evidence-backed target score and missing evidence.", inputSchema: explainTargetMatchInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ score }) => guarded(() => ({ ...explainTargetMatch(score as TargetScore) }))());
  server.registerTool("draft_outreach", { title: "Save outreach draft", description: "Save a private outreach draft. It never sends a LinkedIn message or connection request.", inputSchema: draftOutreachInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async (input) => guarded(() => ({ draft: deps.drafts.createOutreach(input) }))());
  server.registerTool("draft_linkedin_post", { title: "Save LinkedIn post draft", description: "Save a private text-post draft; this does not publish.", inputSchema: draftLinkedInPostInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async (input) => guarded(() => ({ post: deps.drafts.createPost(input) }))());
  server.registerTool("revise_post", { title: "Revise post", description: "Create a new immutable private version of a saved post draft.", inputSchema: revisePostInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async ({ postId, text }) => guarded(() => ({ post: deps.drafts.revisePost(postId, text) }))());
  server.registerTool("preview_post", { title: "Preview post", description: "Show the exact latest saved post and create a one-use 15-minute preview token; this does not publish.", inputSchema: previewPostInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ postId, version }) => guarded(() => ({ preview: deps.previews.create(postId, version) }))());
  server.registerTool("create_weekly_shortlist", { title: "Create shortlist", description: "Save an on-demand private shortlist. It never schedules future work.", inputSchema: createWeeklyShortlistInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async (input) => guarded(() => ({ shortlist: deps.pipeline.createShortlist(input) }))());
  server.registerTool("save_target", { title: "Save target", description: "Save an evidence-backed networking target in the private pipeline.", inputSchema: saveTargetInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async ({ score }) => guarded(() => ({ target: deps.pipeline.saveTarget(score as TargetScore) }))());
  server.registerTool("update_outreach_status", { title: "Update pipeline status", description: "Update a private target's forward-only outreach status.", inputSchema: updateOutreachStatusInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async ({ targetId, status }) => guarded(() => ({ target: deps.pipeline.updateStatus(targetId, pipelineStatusSchema.parse(status)) }))());
  server.registerTool("list_pipeline", { title: "List pipeline", description: "List private networking targets by optional company or status.", inputSchema: listPipelineInput, outputSchema: toolOutputSchema, annotations: readOnly }, async (filter) => guarded(() => ({ targets: deps.pipeline.listPipeline(withoutUndefined(filter)) }))());
  server.registerTool("record_note", { title: "Record private note", description: "Save a private note on a networking target.", inputSchema: recordNoteInput, outputSchema: toolOutputSchema, annotations: privateWrite }, async ({ targetId, text }) => guarded(() => ({ note: deps.pipeline.recordNote(targetId, text) }))());
  server.registerTool("list_post_history", { title: "List post history", description: "List immutable private versions of a saved post draft.", inputSchema: listPostHistoryInput, outputSchema: toolOutputSchema, annotations: readOnly }, async ({ postId }) => guarded(() => ({ posts: deps.drafts.getPostHistory(postId) }))());
  server.registerTool("get_linkedin_connection_status", { title: "Get LinkedIn connection status", description: "Report LinkedIn connection availability without returning credentials.", inputSchema: emptyInputSchema, outputSchema: toolOutputSchema, annotations: readOnly }, async () => guarded(() => ({ connection: deps.getLinkedInConnectionStatus() }))());
  server.registerTool("create_linkedin_authorization_url", { title: "Create LinkedIn authorization URL", description: "Create a short-lived LinkedIn authorization URL. The callback stores tokens server-side.", inputSchema: emptyInputSchema, outputSchema: toolOutputSchema, annotations: privateWrite }, async () => guarded(() => ({ authorizationUrl: deps.linkedin.createAuthorizationUrl() }))());
  server.registerTool("publish_linkedin_post", { title: "Publish exact LinkedIn post", description: "External write: call only when the current user explicitly asks to publish the exact displayed preview. Never batch or retry. Requires an exact fresh one-use preview token.", inputSchema: publishLinkedInPostInput, outputSchema: toolOutputSchema, annotations: externalWrite }, async (input) => guarded(async () => ({ result: await deps.publish.publish(input as PreviewExpected & { previewToken: string }) }))());
  return server;
}
