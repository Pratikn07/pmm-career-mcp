import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { RequestAuthContext } from "../auth/request-context.js";
import { SUPABASE_OAUTH_SCOPES } from "../auth/resource-auth.js";
import type { BrandBriefService } from "../brand/brief-service.js";
import type { BrandRenderService } from "../brand/render-service.js";
import type { DraftService } from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import type { LinkedInOAuth } from "../linkedin/oauth.js";
import type { ImagePublishService } from "../linkedin/image-publish-service.js";
import type { PostMediaService } from "../media/post-media-service.js";
import type { PipelineService } from "../pipeline/service.js";
import type { PreviewService } from "../posts/preview-service.js";
import type { ReviewService } from "../posts/review-service.js";
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
  createBrandedVisualBriefInput,
  createBrandedVisualBriefOutput,
  createExactLinkedInPreviewInput,
  createExactLinkedInPreviewOutput,
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
  getPmmBrandProfileOutput,
  listPipelineInput,
  listPipelineOutput,
  listPostHistoryInput,
  listPostHistoryOutput,
  openLinkedInReviewCardInput,
  openLinkedInReviewCardOutput,
  pipelineStatusSchema,
  publishExactLinkedInPostInput,
  publishExactLinkedInPostOutput,
  rankNetworkingTargetsInput,
  rankNetworkingTargetsOutput,
  recordNoteInput,
  recordNoteOutput,
  renderBrandedLinkedInCoverInput,
  renderBrandedLinkedInCoverOutput,
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

export const CAREER_MCP_INSTRUCTIONS = "Never fetch LinkedIn for research. Never claim complete employee coverage or complete YC-company coverage. Publish only when the current user explicitly asks to publish the exact preview. Never batch or retry publishing. Scheduled runs must present the daily research brief first. If the daily decision is POST CANDIDATE, then save the final private LinkedIn draft, create a structured Editorial Intelligence brief, render and attach the completed branded image as the newest immutable draft version, and call open_linkedin_review_card with expectedImageCount: 1 and dailyBrief set to the presented brief so the complete post-and-image review package opens last. If the decision is not POST CANDIDATE, stop after the brief and selected private action without manufacturing a LinkedIn post. Prefer EDITORIAL_MODEL or EDITORIAL_EVIDENCE for research-led posts; use EDITORIAL_STATEMENT for a short standalone idea and EDITORIAL_METAPHOR only when source art genuinely adds value. Images are curiosity covers, not post summaries; source art must contain no text. New visuals must never display PMM FIELD NOTES. Scheduled and model-driven flows must never create an exact preview, send media to LinkedIn, authorize, or publish. Exact preview and publish actions are app-only. If a user supplies exact draft text, a cover hook, images, alt text, or visibility, use it exactly once. If validation rejects it, stop and report the validation error; never silently substitute or retry with altered content. Research is restricted to YC companies and allowed public sources. Drafts and pipeline data stay private.";

type YcProvider = { searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]> };
type ConnectionStatus = {
  connected: boolean;
  valid: boolean;
  publishingEnabled: boolean;
  imagePublishingEnabled?: boolean;
};

type ModelMediaService = Pick<
  PostMediaService,
  "attachFiles" | "setMedia" | "getVersion" | "createSignedUrls"
>;

export type CareerMcpDependencies = {
  ycProvider: YcProvider;
  peopleDiscovery: PeopleDiscoveryService;
  jobDiscovery: JobDiscoveryService;
  pipeline: Pick<PipelineService, "saveTarget" | "updateStatus" | "recordNote" | "listPipeline" | "createShortlist">;
  drafts: Pick<DraftService, "createOutreach" | "createPost" | "revisePost" | "getPostHistory">;
  previews: Pick<PreviewService, "create">;
  reviews?: Pick<ReviewService, "createExact">;
  publish: Pick<ImagePublishService, "publish">;
  linkedin: Pick<LinkedInOAuth, "createAuthorizationUrl">;
  getLinkedInConnectionStatus: () => Promise<ConnectionStatus>;
  media?: ModelMediaService;
  brand?: Pick<
    BrandBriefService,
    "getProfile" | "createBrief" | "getProvenanceForMedia"
  >;
  brandRenderer?: Pick<BrandRenderService, "render">;
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
  ui: { visibility: ["app"] },
  "openai/widgetAccessible": true
};
const attachFileToolMetadata: Record<string, unknown> = {
  ...oauthToolMetadata,
  "openai/fileParams": ["images"]
};
const brandRenderToolMetadata: Record<string, unknown> = {
  ...oauthToolMetadata,
  "openai/fileParams": ["sourceImage"]
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
    content: [{
      type: "text" as const,
      text: code === "VALIDATION_ERROR"
        ? "Validation failed. If the request specified exact text, a cover hook, images, alt text, or visibility, stop and ask the user for direction; do not retry with altered content."
        : `Operation failed (${code}).`
    }],
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

function modelSafeProfile(
  profile: Awaited<ReturnType<BrandBriefService["getProfile"]>>
) {
  return {
    version: profile.version,
    publicName: profile.publicName,
    roleLine: profile.roleLine,
    seriesName: profile.seriesName,
    monogram: profile.monogram,
    voice: {
      persona: profile.voice.persona,
      traits: [...profile.voice.traits],
      neverInventExperience: profile.voice.neverInventExperience
    },
    palette: { ...profile.palette },
    hookRules: { ...profile.hookRules },
    recentUsage: profile.recentUsage.map((usage) => ({
      templateId: usage.templateId,
      coverHook: usage.coverHook,
      createdAt: usage.createdAt
    }))
  };
}

function modelSafePost(
  post: Awaited<ReturnType<BrandRenderService["render"]>>["post"]
) {
  return {
    id: post.id,
    versionId: post.versionId,
    text: post.text,
    visibility: post.visibility,
    version: post.version,
    checksum: post.checksum,
    state: post.state,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    media: post.media.map((media) => ({
      position: media.position,
      mediaId: media.mediaId,
      altText: media.altText,
      sha256: media.sha256,
      mimeType: media.mimeType,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
      frameCount: media.frameCount,
      originalFilename: media.originalFilename,
      createdAt: media.createdAt
    }))
  };
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

  function authenticatedReview(): Pick<ReviewService, "createExact"> {
    if (options.requestAuthContext === undefined) {
      throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
    }
    if (deps.reviews === undefined) {
      throw new DomainError("DATA_INTEGRITY", "Exact review service is unavailable");
    }
    return deps.reviews;
  }

  function authenticatedPublisher(): Pick<ImagePublishService, "publish"> {
    if (options.requestAuthContext === undefined) {
      throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
    }
    return deps.publish;
  }

  function authenticatedBrand(): Pick<
    BrandBriefService,
    "getProfile" | "createBrief" | "getProvenanceForMedia"
  > {
    if (options.requestAuthContext === undefined) {
      throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
    }
    if (deps.brand === undefined) {
      throw new DomainError("DATA_INTEGRITY", "PMM brand service is unavailable");
    }
    return deps.brand;
  }

  function authenticatedBrandRenderer(): Pick<BrandRenderService, "render"> {
    if (options.requestAuthContext === undefined) {
      throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
    }
    if (deps.brandRenderer === undefined) {
      throw new DomainError("DATA_INTEGRITY", "PMM brand renderer is unavailable");
    }
    return deps.brandRenderer;
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

  server.registerTool("get_pmm_brand_profile", {
    title: "Get PMM brand profile",
    description: "Return the active model-safe Bhagyashree Editorial Intelligence brand rules. Read-only.",
    inputSchema: emptyInputSchema,
    outputSchema: getPmmBrandProfileOutput,
    annotations: readOnly,
    _meta: oauthToolMetadata
  }, async () => guarded(async () => ({
    profile: modelSafeProfile(await authenticatedBrand().getProfile())
  }), () => "Loaded the active Editorial Intelligence brand profile; nothing was changed.")());

  server.registerTool("create_branded_visual_brief", {
    title: "Create branded visual brief",
    description: "Save one private Editorial Intelligence visual brief. Use EDITORIAL_MODEL or EDITORIAL_EVIDENCE for research-led posts so the renderer can create the final card without source art. When the user supplied an exact hook, use it once exactly; if validation rejects it, stop rather than substituting another hook. This does not attach an image, create a preview, or publish.",
    inputSchema: createBrandedVisualBriefInput,
    outputSchema: createBrandedVisualBriefOutput,
    annotations: privateWrite,
    _meta: oauthToolMetadata
  }, async (input) => guarded(async () => {
    const result = await authenticatedBrand().createBrief({
      postId: input.postId,
      expectedVersion: input.expectedVersion,
      coverHook: input.coverHook,
      conceptSummary: input.conceptSummary,
      visualMode: input.visualMode,
      ...(input.visualContent === undefined
        ? {}
        : { visualContent: input.visualContent }
      ),
      ...(input.topicLabel === undefined
        ? {}
        : { topicLabel: input.topicLabel })
    });
    return {
      brief: {
        id: result.brief.id,
        postId: result.brief.postDraftId,
        postVersion: result.brief.postVersion,
        profileVersion: result.brief.brandProfileVersion,
        templateId: result.brief.templateId,
        templateVersion: result.brief.templateVersion,
        promptFormatVersion: result.brief.promptFormatVersion,
        visualMode: result.brief.visualMode,
        coverHook: result.brief.coverHook,
        conceptSummary: result.brief.conceptSummary,
        topicLabel: result.brief.topicLabel,
        generationPrompt: result.brief.generationPrompt,
        negativeConstraints: [...result.brief.negativeConstraintsJson],
        state: result.brief.state,
        createdAt: result.brief.createdAt
      },
      requiresSourceImage: result.requiresSourceImage,
      proposedAltText: result.proposedAltText
    };
  }, () => "Saved one private branded visual brief; no image was attached, previewed, uploaded to LinkedIn, or published.")());

  server.registerTool("render_branded_linkedin_cover", {
    title: "Render branded LinkedIn cover",
    description: "Render and privately attach one completed Editorial Intelligence card to a new immutable post version. Structured model and evidence cards render deterministically without source art. This does not create a preview, send media externally, or publish.",
    inputSchema: renderBrandedLinkedInCoverInput,
    outputSchema: renderBrandedLinkedInCoverOutput,
    annotations: attachmentWrite,
    _meta: brandRenderToolMetadata
  }, async (input) => guarded(async () => {
    const sourceImage = input.sourceImage === undefined
      ? {}
      : {
          sourceImage: {
            download_url: input.sourceImage.download_url,
            file_id: input.sourceImage.file_id,
            ...(input.sourceImage.mime_type === undefined
              ? {}
              : { mime_type: input.sourceImage.mime_type }),
            ...(input.sourceImage.file_name === undefined
              ? {}
              : { file_name: input.sourceImage.file_name })
          }
        };
    const result = await authenticatedBrandRenderer().render({
      briefId: input.briefId,
      postId: input.postId,
      expectedVersion: input.expectedVersion,
      ...sourceImage,
      altText: input.altText
    });
    return {
      post: modelSafePost(result.post),
      provenance: {
        seriesName: result.provenance.seriesName,
        profileVersion: result.provenance.profileVersion,
        templateId: result.provenance.templateId,
        templateVersion: result.provenance.templateVersion,
        coverHook: result.provenance.coverHook,
        renderChecksum: result.provenance.renderChecksum,
        validationPassed: result.provenance.validationPassed,
        validation: {
          fixedLabelsPresent: result.provenance.validation.fixedLabelsPresent,
          textWithinSafeArea: result.provenance.validation.textWithinSafeArea,
          sourceImageUsed: result.provenance.validation.sourceImageUsed
        }
      }
    };
  }, ({ post }) => `Saved one private branded cover in post version ${post.version}; nothing was previewed, uploaded to LinkedIn, or published.`)());

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
  }, async ({ postId, version, expectedImageCount, dailyBrief }) => {
    try {
      const media = authenticatedMedia();
      const post = await media.getVersion(postId, version);
      if (post === undefined) {
        throw new DomainError("NOT_FOUND", "Post draft was not found", { entity: "post_draft" });
      }
      if (
        expectedImageCount !== undefined
        && post.media.length !== expectedImageCount
      ) {
        throw new DomainError(
          "CONFLICT",
          "Review package is incomplete",
          {
            entity: "post_draft",
            expectedImageCount,
            actualImageCount: post.media.length
          }
        );
      }
      const mediaUrls = await media.createSignedUrls(post);
      const positionZeroMedia = post.media.find(({ position }) => position === 0);
      const provenance = positionZeroMedia === undefined || deps.brand === undefined
        ? undefined
        : await deps.brand.getProvenanceForMedia(positionZeroMedia.mediaId);
      const brand = provenance === undefined
        ? undefined
        : {
            seriesName: provenance.seriesName,
            profileVersion: provenance.profileVersion,
            templateId: provenance.templateId,
            templateVersion: provenance.templateVersion,
            coverHook: provenance.coverHook,
            renderChecksum: provenance.renderChecksum,
            validationPassed: provenance.validationPassed
          };
      return {
        ...response({
          post,
          ...(dailyBrief === undefined ? {} : { dailyBrief }),
          ...(brand === undefined ? {} : { brand })
        }, `Opened private post version ${post.version} for review; no preview or publish action was created.`),
        _meta: { mediaUrls: [...mediaUrls] }
      };
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("create_exact_linkedin_preview", {
    title: "Create exact LinkedIn preview",
    description: "Private review-card write: lock one exact latest private draft version for 15 minutes. This does not upload to LinkedIn or publish.",
    inputSchema: createExactLinkedInPreviewInput,
    outputSchema: createExactLinkedInPreviewOutput,
    annotations: privateWrite,
    _meta: appOnlyToolMetadata
  }, async ({ postId, version }) => {
    try {
      const result = await authenticatedReview().createExact(postId, version);
      return {
        content: [{
          type: "text" as const,
          text: "Created an exact one-use post preview valid for 15 minutes; nothing was uploaded or published."
        }],
        structuredContent: { data: { preview: result.preview } },
        _meta: {
          approvalCapability: result.approvalCapability,
          signedMediaUrls: [...result.signedMediaUrls]
        }
      };
    } catch (error) {
      return safeError(error);
    }
  });

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

  server.registerTool("publish_exact_linkedin_post", {
    title: "Publish exact LinkedIn post",
    description: "App-only external write: publish the exact locked preview after explicit human confirmation. Never batch or retry.",
    inputSchema: publishExactLinkedInPostInput,
    outputSchema: publishExactLinkedInPostOutput,
    annotations: externalWrite,
    _meta: appOnlyToolMetadata
  }, async ({ approvalCapability }) => guarded(async () => ({
    result: await authenticatedPublisher().publish(approvalCapability)
  }), ({ result }) => `LinkedIn publish attempt finished with state ${result.state}; it was not retried.`)());

  return server;
}
