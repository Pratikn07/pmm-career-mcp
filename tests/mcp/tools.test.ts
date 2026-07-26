import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { createCareerMcpServer, type CareerMcpDependencies } from "../../src/mcp/server.js";
import { createHttpApp } from "../../src/http/app.js";
import {
  attachLinkedInPostImagesInput,
  attachLinkedInPostImagesOutput,
  createBrandedVisualBriefInput,
  createBrandedVisualBriefOutput,
  confirmFounderProfileCandidateInput,
  exportFounderResearchWorkbookInput,
  processYcFounderResearchInput,
  rankNetworkingTargetsInput,
  renderBrandedLinkedInCoverInput,
  renderBrandedLinkedInCoverOutput,
  saveFounderOutreachBatchInput,
  saveFounderOutreachBatchOutput,
  saveFounderProfileCandidatesInput,
  saveTargetInput,
  startYcFounderResearchInput,
  setLinkedInPostImagesInput
} from "../../src/mcp/schemas.js";
import { scoreTarget, type ScoreTargetInput } from "../../src/ranking/score-target.js";
import { DomainError } from "../../src/domain/errors.js";
import request from "supertest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const expectedTools = [
  "search_yc_companies",
  "discover_public_people",
  "find_pmm_opportunities",
  "rank_networking_targets",
  "explain_target_match",
  "draft_outreach",
  "draft_linkedin_post",
  "revise_post",
  "get_pmm_brand_profile",
  "create_branded_visual_brief",
  "render_branded_linkedin_cover",
  "attach_linkedin_post_images",
  "set_linkedin_post_images",
  "open_linkedin_review_card",
  "create_exact_linkedin_preview",
  "create_weekly_shortlist",
  "save_target",
  "update_outreach_status",
  "list_pipeline",
  "record_note",
  "list_post_history",
  "get_linkedin_connection_status",
  "create_linkedin_authorization_url",
  "publish_exact_linkedin_post",
  "start_yc_founder_research",
  "process_yc_founder_research",
  "save_founder_profile_candidates",
  "confirm_founder_profile_candidate",
  "save_founder_outreach_batch",
  "export_founder_research_workbook"
] as const;

const FIXED_NOW = new Date("2026-07-17T00:00:00.000Z");
const BRAND_POST_ID = "123e4567-e89b-12d3-a456-426614174001";
const BRAND_BRIEF_ID = "123e4567-e89b-12d3-a456-426614174002";

it("publishes strict bounded Brand Studio inputs", () => {
  const brief = {
    postId: BRAND_POST_ID,
    expectedVersion: 1,
    coverHook: "Clarity beats capability.",
    conceptSummary: "Restrained editorial geometry about choosing clarity",
    visualMode: "EDITORIAL_STATEMENT" as const,
    topicLabel: "POSITIONING"
  };
  const render = {
    briefId: BRAND_BRIEF_ID,
    postId: BRAND_POST_ID,
    expectedVersion: 1,
    sourceImage: {
      download_url: "https://files.example/source.png",
      file_id: "file-source",
      mime_type: "image/png",
      file_name: "source.png"
    },
    altText: "Editorial PMM Field Notes cover about product clarity."
  };

  expect(createBrandedVisualBriefInput.parse(brief)).toEqual(brief);
  expect(createBrandedVisualBriefInput.safeParse({ ...brief, extra: true }).success).toBe(false);
  expect(createBrandedVisualBriefInput.safeParse({ ...brief, coverHook: "x".repeat(73) }).success).toBe(false);
  expect(createBrandedVisualBriefInput.safeParse({ ...brief, conceptSummary: "x".repeat(501) }).success).toBe(false);
  expect(createBrandedVisualBriefInput.safeParse({ ...brief, topicLabel: "x".repeat(25) }).success).toBe(false);
  expect(renderBrandedLinkedInCoverInput.parse(render)).toEqual(render);
  expect(renderBrandedLinkedInCoverInput.safeParse({ ...render, extra: true }).success).toBe(false);
  expect(renderBrandedLinkedInCoverInput.safeParse({
    ...render,
    altText: "two\nlines"
  }).success).toBe(false);
});

it("counts LinkedIn image alt text by Unicode code point in input and output schemas", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const alt120 = "🙂".repeat(120);
  const alt121 = `${alt120}🙂`;
  const attach = (altText: string) => ({
    postId: id,
    expectedVersion: 1,
    images: [{ download_url: "https://files.example/image.png", file_id: "file-1" }],
    altTexts: [altText]
  });
  const set = (altText: string) => ({
    postId: id,
    expectedVersion: 1,
    media: [{ mediaId: id, altText }]
  });
  const output = (altText: string) => ({ data: { post: {
    id,
    versionId: "123e4567-e89b-12d3-a456-426614174001",
    text: "Exact post",
    visibility: "CONNECTIONS",
    version: 1,
    checksum: "a".repeat(64),
    state: "draft",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    media: [{
      position: 0,
      mediaId: id,
      altText,
      sha256: "b".repeat(64),
      mimeType: "image/png",
      byteSize: 1,
      width: 1,
      height: 1,
      frameCount: 1,
      originalFilename: null,
      createdAt: FIXED_NOW.toISOString()
    }]
  } } });

  expect(attachLinkedInPostImagesInput.safeParse(attach(alt120)).success).toBe(true);
  expect(setLinkedInPostImagesInput.safeParse(set(alt120)).success).toBe(true);
  expect(attachLinkedInPostImagesOutput.safeParse(output(alt120)).success).toBe(true);
  expect(attachLinkedInPostImagesInput.safeParse(attach(alt121)).success).toBe(false);
  expect(setLinkedInPostImagesInput.safeParse(set(alt121)).success).toBe(false);
  expect(attachLinkedInPostImagesOutput.safeParse(output(alt121)).success).toBe(false);
});

function scoringTarget(overrides: Partial<ScoreTargetInput> = {}): ScoreTargetInput {
  return {
    companyName: "Acme",
    person: {
      id: "person-1",
      companyId: "company-1",
      name: "Ada Lovelace",
      role: "VP Marketing",
      checkedAt: FIXED_NOW.toISOString(),
      confidence: 0.9,
      evidence: [{
        id: "evidence-1",
        url: "https://acme.example/team",
        sourceUrl: "https://acme.example/team",
        title: "Leadership",
        fact: "Ada is VP Marketing",
        checkedAt: FIXED_NOW.toISOString(),
        confidence: 0.9
      }]
    },
    opportunities: [{
      id: "opportunity-1",
      companyId: "company-1",
      title: "Product Marketing Manager",
      location: "San Francisco",
      sourceUrl: "https://acme.example/careers/pmm",
      checkedAt: FIXED_NOW.toISOString(),
      active: true
    }],
    preferences: {
      roleKeywords: ["product marketing"],
      preferredLocations: ["San Francisco"],
      industries: ["SaaS"]
    },
    weights: { pmmOpportunity: 0.4, referralPotential: 0.3, networkValue: 0.3 },
    evidence: {
      activePmmRole: true,
      companyHiring: true,
      roleSeniority: true,
      sharedDomain: true,
      locationMatch: true,
      recentFundingSignal: false,
      companyCheckedAt: FIXED_NOW.toISOString()
    },
    ...overrides
  };
}

function createServerWithClock(
  deps: CareerMcpDependencies,
  now: () => Date
) {
  return createCareerMcpServer(deps, { now });
}

function dependencies(): CareerMcpDependencies {
  return {
    ycProvider: { searchYcCompanies: async () => [] },
    peopleDiscovery: {
      projectOfficialPeople: async () => ({
        people: [], evidence: [], checkedAt: "2026-07-17T00:00:00.000Z", coverage: "authoritative-pages-only", warnings: []
      }),
      discoverPublicPeople: async () => ({
        people: [], evidence: [], checkedAt: "2026-07-17T00:00:00.000Z", coverage: "authoritative-pages-only", warnings: []
      })
    },
    jobDiscovery: { findPmmOpportunities: async () => ({
      opportunities: [], checkedAt: "2026-07-17T00:00:00.000Z", warnings: []
    }) },
    pipeline: {
      saveTarget: () => { throw new Error("not called"); },
      updateStatus: () => { throw new Error("not called"); },
      recordNote: () => { throw new Error("not called"); },
      listPipeline: async () => [],
      createShortlist: () => { throw new Error("not called"); }
    },
    drafts: {
      createOutreach: () => { throw new Error("not called"); },
      createPost: () => { throw new Error("not called"); },
      revisePost: () => { throw new Error("not called"); },
      getPostHistory: async () => []
    },
    previews: { create: () => { throw new Error("not called"); } },
    reviews: { createExact: () => { throw new Error("not called"); } },
    publish: { publish: async () => ({ state: "publish_failed" as const }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: async () => ({ connected: false, valid: false, publishingEnabled: false, imagePublishingEnabled: false })
  };
}

function successfulDependencies(): CareerMcpDependencies {
  const timestamp = FIXED_NOW.toISOString();
  const score = scoreTarget(scoringTarget(), FIXED_NOW);
  const pipelineTarget = {
    id: "target-1",
    personId: score.personId,
    pmmOpportunity: score.pmmOpportunity,
    referralPotential: score.referralPotential,
    networkValue: score.networkValue,
    totalScore: score.total,
    confidence: score.confidence,
    status: "discovered" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    reasons: score.reasons,
    missingEvidence: score.missingEvidence
  };
  const post = {
    id: "post-1",
    versionId: "post-version-1",
    text: "A safe test post",
    visibility: "PUBLIC" as const,
    version: 1,
    checksum: "a".repeat(64),
    state: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    media: []
  };
  const brandProfile = {
    version: 1 as const,
    publicName: "BHAGYASHREE NANDOSKAR",
    roleLine: "PRODUCT MARKETING",
    seriesName: "PMM FIELD NOTES",
    monogram: "BN",
    voice: {
      persona: "curious PMM practitioner",
      traits: ["thoughtful", "practical", "observant", "conversational", "evidence-aware"],
      neverInventExperience: true as const
    },
    palette: {
      ivory: "#F6F1E8",
      navy: "#14233A",
      copper: "#B97850",
      taupe: "#C9B8A5",
      highlight: "#FFFDF9"
    },
    hookRules: {
      minWords: 2 as const,
      maxWords: 8 as const,
      maxCharacters: 72 as const,
      recentWindow: 30 as const
    },
    recentUsage: [{
      templateId: "editorial-statement-v1",
      coverHook: "Clarity beats capability.",
      createdAt: timestamp
    }]
  };
  const brief = {
    id: BRAND_BRIEF_ID,
    ownerSubject: "123e4567-e89b-12d3-a456-426614174000",
    postDraftId: BRAND_POST_ID,
    postVersion: 1,
    brandProfileId: "123e4567-e89b-12d3-a456-426614174003",
    brandProfileVersion: 1,
    templateId: "editorial-statement-v1",
    templateVersion: 1,
    promptFormatVersion: 1,
    visualMode: "EDITORIAL_STATEMENT",
    coverHook: "Clarity beats capability.",
    conceptSummary: "Restrained editorial geometry about choosing clarity",
    topicLabel: "POSITIONING",
    generationPrompt: "Create text-free restrained abstract editorial geometry.",
    negativeConstraintsJson: ["readable text", "logos", "watermarks"],
    state: "ready",
    createdAt: timestamp
  };
  const renderedPost = {
    ...post,
    id: BRAND_POST_ID,
    versionId: "123e4567-e89b-12d3-a456-426614174004",
    version: 2,
    checksum: "b".repeat(64),
    media: [{
      position: 0,
      mediaId: "123e4567-e89b-12d3-a456-426614174005",
      altText: "Editorial PMM Field Notes cover about product clarity.",
      sha256: "c".repeat(64),
      mimeType: "image/png" as const,
      byteSize: 2048,
      width: 1080,
      height: 1350,
      frameCount: 1,
      originalFilename: "brand-cover.png",
      createdAt: timestamp
    }]
  };
  return {
    ycProvider: {
      searchYcCompanies: async () => [{
        id: "company-1",
        ycId: "acme-yc",
        name: "Acme",
        checkedAt: timestamp,
        sources: scoringTarget().person.evidence,
        warnings: []
      }]
    },
    peopleDiscovery: {
      projectOfficialPeople: async () => ({
        people: [],
        evidence: [],
        checkedAt: timestamp,
        coverage: "authoritative-pages-only",
        warnings: []
      }),
      discoverPublicPeople: async () => ({
        people: [scoringTarget().person],
        evidence: scoringTarget().person.evidence,
        checkedAt: timestamp,
        coverage: "authoritative-pages-only",
        warnings: []
      })
    },
    jobDiscovery: {
      findPmmOpportunities: async () => ({
        opportunities: [...scoringTarget().opportunities],
        checkedAt: timestamp,
        warnings: []
      })
    },
    pipeline: {
      saveTarget: async () => pipelineTarget,
      updateStatus: async () => ({ ...pipelineTarget, status: "shortlisted" }),
      recordNote: async () => ({
        id: "note-1",
        targetId: "target-1",
        text: "Private note",
        createdAt: timestamp,
        updatedAt: timestamp
      }),
      listPipeline: async () => [pipelineTarget],
      createShortlist: async () => ({
        id: "shortlist-1",
        name: "This week",
        createdAt: timestamp,
        updatedAt: timestamp,
        entries: [{
          id: "shortlist-entry-1",
          shortlistId: "shortlist-1",
          targetId: "target-1",
          position: 0,
          createdAt: timestamp
        }]
      })
    },
    drafts: {
      createOutreach: async () => ({
        id: "outreach-1",
        targetId: "target-1",
        purpose: "networking",
        text: "Hello",
        version: 1,
        evidenceIds: ["evidence-1"],
        createdAt: timestamp,
        updatedAt: timestamp
      }),
      createPost: async () => post,
      revisePost: async () => ({ ...post, versionId: "post-version-2", version: 2 }),
      getPostHistory: async () => [post]
    },
    previews: {
      create: async () => ({
        postId: post.id,
        versionId: post.versionId,
        text: post.text,
        version: post.version,
        checksum: post.checksum,
        visibility: post.visibility,
        characterCount: [...post.text].length,
        previewToken: "A".repeat(43),
        expiresAt: "2026-07-17T00:15:00.000Z"
      })
    },
    reviews: {
      createExact: async () => ({
        preview: {
          postId: post.id,
          versionId: post.versionId,
          text: post.text,
          version: post.version,
          checksum: post.checksum,
          visibility: post.visibility,
          characterCount: [...post.text].length,
          media: [],
          expiresAt: "2026-07-17T00:15:00.000Z"
        },
        approvalCapability: "A".repeat(43),
        signedMediaUrls: []
      })
    },
    brand: {
      getProfile: async () => brandProfile,
      createBrief: async () => ({
        brief,
        profile: brandProfile,
        requiresSourceImage: false,
        proposedAltText: "Editorial PMM Field Notes cover reading “Clarity beats capability.”."
      }),
      getProvenanceForMedia: async () => undefined
    },
    brandRenderer: {
      render: async () => ({
        post: renderedPost,
        provenance: {
          seriesName: "PMM FIELD NOTES",
          profileVersion: 1,
          templateId: "editorial-statement-v1",
          templateVersion: 1,
          coverHook: "Clarity beats capability.",
          renderChecksum: "c".repeat(64),
          validationPassed: true,
          validation: {
            fixedLabelsPresent: true as const,
            textWithinSafeArea: true as const,
            sourceImageUsed: false
          }
        }
      })
    },
    publish: { publish: async () => ({ state: "published", postUrn: "urn:li:share:12345" }) },
    linkedin: { createAuthorizationUrl: () => "https://www.linkedin.com/oauth/v2/authorization" },
    getLinkedInConnectionStatus: async () => ({ connected: true, valid: true, publishingEnabled: false, imagePublishingEnabled: false })
  };
}

async function listTools() {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await Promise.all([client.close(), server.close()]);
  return result.tools;
}

it("registers exactly the approved Career MCP tools", async () => {
  const tools = await listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
  expect(tools.map((tool) => tool.name).some((name) => /scrape|message|schedule/.test(name))).toBe(false);
  expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
});

it("publishes strict bounded founder-research inputs", () => {
  const runId = "123e4567-e89b-12d3-a456-426614174010";
  const runItemId = "123e4567-e89b-12d3-a456-426614174011";
  const runPersonId = "123e4567-e89b-12d3-a456-426614174012";
  const personId = "123e4567-e89b-12d3-a456-426614174013";
  const candidateId = "123e4567-e89b-12d3-a456-426614174014";
  const evidenceId = "123e4567-e89b-12d3-a456-426614174015";
  const start = startYcFounderResearchInput.parse({ limit: 50 });
  expect(start).toEqual({ limit: 50 });
  expect(startYcFounderResearchInput.safeParse({ limit: 51 }).success).toBe(false);
  expect(startYcFounderResearchInput.safeParse({ ownerSubject: runId }).success).toBe(false);
  expect(processYcFounderResearchInput.parse({ runId, maxCompanies: 5 })).toEqual({ runId, maxCompanies: 5 });
  expect(processYcFounderResearchInput.safeParse({ runId, maxCompanies: 6 }).success).toBe(false);
  expect(processYcFounderResearchInput.safeParse({ runId, extra: true }).success).toBe(false);

  const candidate = {
    runItemId,
    runPersonId,
    founderName: "Ada Lovelace",
    founderRole: "Co-founder",
    candidateProfileUrl: "https://www.linkedin.com/in/ada-lovelace",
    searchQuery: "Ada Lovelace Acme LinkedIn",
    resultUrl: "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
    resultTitle: "Ada Lovelace at Acme",
    checkedAt: FIXED_NOW.toISOString(),
    confidence: 0.8,
    linkedInNotFetched: true
  };
  expect(saveFounderProfileCandidatesInput.parse({ runId, candidates: [candidate] })).toEqual({ runId, candidates: [candidate] });
  const { runPersonId: _runPersonId, ...unresolvedIdentity } = candidate;
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: [unresolvedIdentity] }).success).toBe(true);
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: [{ ...candidate, resultTitle: undefined }] }).success).toBe(false);
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: Array.from({ length: 26 }, () => candidate) }).success).toBe(false);
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: [{ ...candidate, linkedInNotFetched: false }] }).success).toBe(false);
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: [{ ...candidate, resultUrl: "https://www.linkedin.com/in/ada-lovelace?unsafe=value" }] }).success).toBe(false);
  expect(saveFounderProfileCandidatesInput.safeParse({ runId, candidates: [{ ...candidate, candidateProfileUrl: "https://www.linkedin.com/in/Ada-Lovelace", resultUrl: "https://www.linkedin.com/in/ada-lovelace" }] }).success).toBe(false);
  expect(confirmFounderProfileCandidateInput.parse({ candidateId, decision: "CONFIRM" })).toEqual({ candidateId, decision: "CONFIRM" });
  expect(confirmFounderProfileCandidateInput.safeParse({ candidateId, decision: "DELETE" }).success).toBe(false);

  const outreach = {
    personId,
    pmmOpportunity: 50,
    referralPotential: 50,
    networkValue: 50,
    total: 50,
    confidence: 0.8,
    reasons: ["Evidence-backed"],
    missingEvidence: [],
    evidenceIds: [evidenceId],
    personalizationClaims: [{ text: "Acme's launch", evidenceIds: [evidenceId] }],
    text: "Hi Ada — I appreciated Acme's launch. I'd value connecting.",
    reviewState: "READY_TO_REVIEW"
  };
  expect(saveFounderOutreachBatchInput.safeParse({ runId, requestId: "request-1", entries: [outreach] }).success).toBe(true);
  expect(saveFounderOutreachBatchInput.safeParse({
    runId,
    requestId: "request-1",
    entries: [{ ...outreach, text: "🙂".repeat(200) }]
  }).success).toBe(true);
  expect(saveFounderOutreachBatchInput.safeParse({
    runId,
    requestId: "request-1",
    entries: [{ ...outreach, text: "🙂".repeat(201) }]
  }).success).toBe(false);
  expect(saveFounderOutreachBatchOutput.safeParse({ data: {
    drafts: [{
      personId,
      targetId: "123e4567-e89b-12d3-a456-426614174016",
      draftId: "123e4567-e89b-12d3-a456-426614174017",
      version: 1,
      purpose: "linkedin_connection_request",
      text: "🙂".repeat(200),
      evidenceIds: []
    }],
    needsVerification: []
  } }).success).toBe(true);
  expect(saveFounderOutreachBatchInput.safeParse({ runId, requestId: "request-1", entries: Array.from({ length: 26 }, () => outreach) }).success).toBe(false);
  expect(exportFounderResearchWorkbookInput.parse({ runId })).toEqual({ runId, includeCandidateUrls: true });
  expect(exportFounderResearchWorkbookInput.safeParse({ runId, includeCandidateUrls: false }).success).toBe(false);
  expect(exportFounderResearchWorkbookInput.safeParse({ runId, extra: true }).success).toBe(false);
});

it("uses owner-scoped founder services and keeps export capabilities widget-private", async () => {
  const runId = "123e4567-e89b-12d3-a456-426614174010";
  const runItemId = "123e4567-e89b-12d3-a456-426614174011";
  const runPersonId = "123e4567-e89b-12d3-a456-426614174012";
  const personId = "123e4567-e89b-12d3-a456-426614174013";
  const candidateId = "123e4567-e89b-12d3-a456-426614174014";
  const exportId = "123e4567-e89b-12d3-a456-426614174016";
  const run = {
    id: runId,
    state: "PENDING",
    queryJson: {},
    requestedLimit: 1,
    selectedCount: 1,
    processedCount: 0,
    completeCount: 0,
    partialCount: 0,
    ambiguousCount: 0,
    notFoundCount: 0,
    failedCount: 0,
    createdAt: FIXED_NOW.toISOString(),
    startedAt: null,
    completedAt: null,
    updatedAt: FIXED_NOW.toISOString()
  };
  const candidate = {
    id: candidateId,
    runPersonId,
    profileUrl: "https://www.linkedin.com/in/ada-lovelace",
    status: "CANDIDATE",
    sourceKind: "PUBLIC_SEARCH",
    searchQuery: "Ada Lovelace Acme LinkedIn",
    evidenceUrl: "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
    evidenceTitle: "Ada Lovelace at Acme",
    evidenceSnippet: null,
    checkedAt: FIXED_NOW.toISOString(),
    confidence: 0.8,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString()
  };
  const capability = "A".repeat(43);
  const startRun = vi.fn(async () => ({ run, selectedCompanyIds: ["123e4567-e89b-12d3-a456-426614174017"] }));
  const processRun = vi.fn(async () => ({
    run: { ...run, state: "NEEDS_PUBLIC_SEARCH" },
    leasedCount: 1,
    items: Array.from({ length: 6 }, (_, index) => ({ runItemId: `${runItemId.slice(0, -1)}${index}`, companyId: "123e4567-e89b-12d3-a456-426614174017", leaseAttempt: 1, state: "NEEDS_PUBLIC_SEARCH", founderCount: 1, verifiedProfileCount: 0, ...(index === 0 ? { errorCode: "OFFICIAL_SOURCE_UNAVAILABLE", errorSummary: "Official source unavailable" } : {}) })),
    publicSearchTasks: Array.from({ length: 26 }, (_, index) => ({ runItemId: `${runItemId.slice(0, -2)}${String(index).padStart(2, "0")}`, companyId: "123e4567-e89b-12d3-a456-426614174017", companyName: "Acme", suggestedQueries: ["Ada Lovelace Acme LinkedIn"], reason: "PROFILE_URL_MISSING" })),
    shouldContinue: false
  }));
  const saveCandidate = vi.fn(async () => ({ candidate, canonical: undefined, requiresManualReview: true }));
  const saveCandidateForRunItem = vi.fn(async () => ({ candidate, canonical: undefined, requiresManualReview: true }));
  const decideCandidate = vi.fn(async () => ({ candidate: { ...candidate, status: "CONFIRMED" }, canonical: { ...candidate, status: "CONFIRMED" }, requiresManualReview: false }));
  const saveBatch = vi.fn(async () => ({
    drafts: [{ personId, targetId: "123e4567-e89b-12d3-a456-426614174018", draftId: "123e4567-e89b-12d3-a456-426614174019", version: 1, purpose: "linkedin_connection_request", text: "Hi Ada — I'd value connecting.", evidenceIds: [] }],
    needsVerification: []
  }));
  const createExport = vi.fn(async (_input: unknown, privateMetadata: (value: { capability: string; expiresAt: string }) => void) => {
    privateMetadata({ capability, expiresAt: "2026-07-17T00:15:00.000Z" });
    return {
      id: exportId,
      runId,
      createdAt: FIXED_NOW.toISOString(),
      fileName: "founder-research.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 100,
      checksumSha256: "a".repeat(64),
      rowCount: 1,
      sheetCount: 4,
      expiresAt: "2026-07-24T00:00:00.000Z"
    };
  });
  const deps = dependencies() as CareerMcpDependencies & { founderResearch: unknown };
  deps.founderResearch = {
    applicationUrl: "https://career.example",
    runs: { startRun: startRun as never, processRun: processRun as never },
    candidates: { saveCandidate: saveCandidate as never, saveCandidateForRunItem: saveCandidateForRunItem as never, decideCandidate: decideCandidate as never },
    outreach: { saveBatch: saveBatch as never },
    exports: { createExport: createExport as never }
  };
  const server = createCareerMcpServer(deps, {
    requestAuthContext: { subject: "123e4567-e89b-12d3-a456-426614174000", accessToken: "request-token" }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const start = await client.callTool({ name: "start_yc_founder_research", arguments: { limit: 1 } });
  expect(start.structuredContent).toMatchObject({ data: { run: { id: runId }, selectedCompanyIds: ["123e4567-e89b-12d3-a456-426614174017"] } });
  expect(startRun).toHaveBeenCalledWith({}, 1);
  const processed = await client.callTool({ name: "process_yc_founder_research", arguments: { runId, maxCompanies: 5 } });
  expect(processed.structuredContent).toMatchObject({ data: { shouldContinue: false } });
  expect((processed.structuredContent as { data: { items: unknown[]; publicSearchTasks: unknown[] } }).data.items).toHaveLength(5);
  expect((processed.structuredContent as { data: { items: unknown[]; publicSearchTasks: unknown[] } }).data.publicSearchTasks).toHaveLength(25);
  expect((processed.structuredContent as { data: { items: unknown[] } }).data.items[0]).toMatchObject({ errorCode: "OFFICIAL_SOURCE_UNAVAILABLE", errorSummary: "Official source unavailable" });
  expect(processRun).toHaveBeenCalledWith(runId, 5);
  await client.callTool({ name: "save_founder_profile_candidates", arguments: { runId, candidates: [{ runItemId, founderName: "Ada Lovelace", founderRole: "Co-founder", candidateProfileUrl: candidate.profileUrl, searchQuery: candidate.searchQuery, resultUrl: candidate.evidenceUrl, resultTitle: candidate.evidenceTitle, checkedAt: candidate.checkedAt, confidence: candidate.confidence, linkedInNotFetched: true }] } });
  expect(saveCandidateForRunItem).toHaveBeenCalledOnce();
  expect(saveCandidate).not.toHaveBeenCalled();
  await client.callTool({ name: "confirm_founder_profile_candidate", arguments: { candidateId, decision: "CONFIRM" } });
  expect(decideCandidate).toHaveBeenCalledWith({ candidateId, decision: "CONFIRM" });
  await client.callTool({ name: "save_founder_outreach_batch", arguments: { runId, requestId: "request-1", entries: [{ personId, pmmOpportunity: 50, referralPotential: 50, networkValue: 50, total: 50, confidence: 0.8, reasons: ["Evidence-backed"], missingEvidence: [], evidenceIds: [], personalizationClaims: [], text: "Hi Ada — I'd value connecting.", reviewState: "READY_TO_REVIEW" }] } });
  expect(saveBatch).toHaveBeenCalledOnce();
  const exported = await client.callTool({ name: "export_founder_research_workbook", arguments: { runId } });
  const resources = await client.listResources();
  await Promise.all([client.close(), server.close()]);

  expect(exported.structuredContent).toEqual({ data: { export: { id: exportId, runId, createdAt: FIXED_NOW.toISOString(), expiresAt: "2026-07-24T00:00:00.000Z", rowCount: 1, sheetCount: 4, checksumSha256: "a".repeat(64) } } });
  expect(exported._meta).toEqual({ downloadUrl: `https://career.example/research-exports/${exportId}/download?capability=${capability}`, expiresAt: "2026-07-17T00:15:00.000Z" });
  expect(createExport).toHaveBeenCalledWith({ runId, idempotencyKey: `founder-export:${runId}:v1` }, expect.any(Function));
  expect(JSON.stringify(exported.content)).not.toContain(capability);
  expect(JSON.stringify(exported.structuredContent)).not.toContain(capability);
  expect(JSON.stringify(exported.content)).not.toContain("/download?");
  expect(JSON.stringify(exported.structuredContent)).not.toContain("/download?");
  expect(resources.resources.map((resource) => resource.uri)).toContain("ui://pmm-career-mcp/founder-export-card.html");
});

it("requires authenticated owner-scoped founder services and maps only stable errors", async () => {
  const runId = "123e4567-e89b-12d3-a456-426614174010";
  const deps = dependencies() as CareerMcpDependencies & { founderResearch: unknown };
  const startRun = vi.fn(async () => { throw new DomainError("EVIDENCE_MISMATCH", "internal candidate detail"); });
  deps.founderResearch = {
    applicationUrl: "https://career.example",
    runs: { startRun: startRun as never, processRun: vi.fn() as never },
    candidates: { saveCandidate: vi.fn() as never, saveCandidateForRunItem: vi.fn() as never, decideCandidate: vi.fn() as never },
    outreach: { saveBatch: vi.fn() as never },
    exports: { createExport: vi.fn() as never }
  };
  const unauthenticated = createCareerMcpServer(deps);
  const [unauthClientTransport, unauthServerTransport] = InMemoryTransport.createLinkedPair();
  const unauthClient = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([unauthenticated.connect(unauthServerTransport), unauthClient.connect(unauthClientTransport)]);
  const unauthResult = await unauthClient.callTool({ name: "start_yc_founder_research", arguments: { limit: 1 } });
  await Promise.all([unauthClient.close(), unauthenticated.close()]);
  expect(unauthResult.structuredContent).toEqual({ data: { error: { code: "AUTH_REQUIRED" } } });
  expect(startRun).not.toHaveBeenCalled();

  const authenticated = createCareerMcpServer(deps, {
    requestAuthContext: { subject: "123e4567-e89b-12d3-a456-426614174000", accessToken: "request-token" }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([authenticated.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "start_yc_founder_research", arguments: { limit: 1 } });
  await Promise.all([client.close(), authenticated.close()]);
  expect(result.structuredContent).toEqual({ data: { error: { code: "EVIDENCE_MISMATCH" } } });
  expect(JSON.stringify(result)).not.toContain("internal candidate detail");
  expect(JSON.stringify(result)).not.toContain(runId);
});

it("keeps exact publishing app-only with capability-only input and secret-free output", async () => {
  const capability = "Q".repeat(43);
  const deps = dependencies();
  const publish = vi.fn(async () => ({ state: "publish_failed" as const }));
  deps.publish = { publish };
  const server = createCareerMcpServer(deps, {
    requestAuthContext: Object.freeze({
      subject: "123e4567-e89b-12d3-a456-426614174000",
      accessToken: "request-token"
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  const tool = tools.tools.find(({ name }) => name === "publish_exact_linkedin_post");
  expect(tool?.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ["approvalCapability"],
    properties: { approvalCapability: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } }
  });
  expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["approvalCapability"]);

  const result = await client.callTool({
    name: "publish_exact_linkedin_post",
    arguments: { approvalCapability: capability }
  });
  expect(publish).toHaveBeenCalledWith(capability);
  expect(JSON.stringify(result)).not.toContain(capability);
  expect(result.structuredContent).toEqual({ data: { result: { state: "publish_failed" } } });
  await Promise.all([client.close(), server.close()]);
});

it("publishes an explicit success and safe-error output contract for every tool", async () => {
  const tools = await listTools();
  const successKeys: Record<(typeof expectedTools)[number], string> = {
    search_yc_companies: "companies",
    discover_public_people: "people",
    find_pmm_opportunities: "opportunities",
    rank_networking_targets: "targets",
    explain_target_match: "score",
    draft_outreach: "draft",
    draft_linkedin_post: "post",
    revise_post: "post",
    get_pmm_brand_profile: "profile",
    create_branded_visual_brief: "brief",
    render_branded_linkedin_cover: "post",
    attach_linkedin_post_images: "post",
    set_linkedin_post_images: "post",
    open_linkedin_review_card: "post",
    create_exact_linkedin_preview: "preview",
    create_weekly_shortlist: "shortlist",
    save_target: "target",
    update_outreach_status: "target",
    list_pipeline: "targets",
    record_note: "note",
    list_post_history: "posts",
    get_linkedin_connection_status: "connection",
    create_linkedin_authorization_url: "authorizationUrl",
    publish_exact_linkedin_post: "result",
    start_yc_founder_research: "run",
    process_yc_founder_research: "items",
    save_founder_profile_candidates: "results",
    confirm_founder_profile_candidate: "candidate",
    save_founder_outreach_batch: "drafts",
    export_founder_research_workbook: "export"
  };

  for (const tool of tools) {
    const serialized = JSON.stringify(tool.outputSchema);
    expect(serialized, `${tool.name} success schema`).toContain(`\"${successKeys[tool.name as keyof typeof successKeys]}\"`);
    expect(serialized, `${tool.name} safe error schema`).toContain("\"error\"");
    expect(serialized, `${tool.name} safe error code`).toContain("\"code\"");
    expect(serialized, `${tool.name} does not expose an untyped record`).not.toContain("additionalProperties\":{}");
  }
});

it("rejects caller-authored numeric networking scores", () => {
  const legacyScore = {
    personId: "person-1",
    companyId: "company-1",
    companyName: "Acme",
    name: "Ada Lovelace",
    pmmOpportunity: 100,
    referralPotential: 100,
    networkValue: 100,
    total: 100,
    confidence: 1,
    reasons: [],
    missingEvidence: []
  };
  expect(rankNetworkingTargetsInput.safeParse({ scores: [legacyScore] }).success).toBe(false);
  expect(saveTargetInput.safeParse({ score: legacyScore }).success).toBe(false);
});

it("calculates and ranks networking scores on the server", async () => {
  const target = scoringTarget();
  const server = createServerWithClock(dependencies(), () => new Date(FIXED_NOW));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "rank_networking_targets",
    arguments: { targets: [target] }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.structuredContent).toEqual({
    data: { targets: [scoreTarget(target, FIXED_NOW)] }
  });
});

it("recalculates a networking score immediately before persistence", async () => {
  const target = scoringTarget();
  const expectedScore = scoreTarget(target, FIXED_NOW);
  const persistence = deferred<Record<string, unknown>>();
  const captured: unknown[] = [];
  const saveDependencies = dependencies();
  saveDependencies.pipeline.saveTarget = (async (score) => {
    captured.push(score);
    return await persistence.promise;
  }) as CareerMcpDependencies["pipeline"]["saveTarget"];
  const server = createServerWithClock(saveDependencies, () => new Date(FIXED_NOW));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const resultPromise = client.callTool({ name: "save_target", arguments: { target } });
  await vi.waitFor(() => expect(captured).toHaveLength(1));
  expect(captured[0]).toEqual(expectedScore);
  persistence.resolve({
    id: "target-1",
    personId: expectedScore.personId,
    pmmOpportunity: expectedScore.pmmOpportunity,
    referralPotential: expectedScore.referralPotential,
    networkValue: expectedScore.networkValue,
    totalScore: expectedScore.total,
    confidence: expectedScore.confidence,
    status: "discovered",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    reasons: expectedScore.reasons,
    missingEvidence: expectedScore.missingEvidence
  });
  const result = await resultPromise;
  await Promise.all([client.close(), server.close()]);

  expect(result.isError).not.toBe(true);
});

it("returns bounded useful text instead of the generic Done response", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "search_yc_companies", arguments: {} });
  await Promise.all([client.close(), server.close()]);

  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text ?? "";
  expect(text).not.toBe("Done.");
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThanOrEqual(240);
  expect(text).toContain("0");
});

it("returns schema-valid structured data and bounded summaries from every registered tool", async () => {
  const target = scoringTarget();
  const successful = successfulDependencies();
  const mediaPost = await successful.drafts.createPost({
    text: "A safe test post",
    visibility: "PUBLIC"
  });
  successful.media = {
    attachFiles: async () => mediaPost,
    setMedia: async () => mediaPost,
    getVersion: async () => mediaPost,
    createSignedUrls: async () => []
  };
  const server = createCareerMcpServer(successful, {
    now: () => new Date(FIXED_NOW),
    requestAuthContext: Object.freeze({
      subject: "123e4567-e89b-12d3-a456-426614174000",
      accessToken: "test-request-token"
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const calls: Array<{ name: (typeof expectedTools)[number]; arguments: Record<string, unknown> }> = [
    { name: "search_yc_companies", arguments: {} },
    { name: "discover_public_people", arguments: { companyId: "company-1" } },
    { name: "find_pmm_opportunities", arguments: { companyIds: ["company-1"], preferences: target.preferences } },
    { name: "rank_networking_targets", arguments: { targets: [target] } },
    { name: "explain_target_match", arguments: { target } },
    { name: "draft_outreach", arguments: { targetId: "target-1", purpose: "networking", text: "Hello", evidenceIds: ["evidence-1"] } },
    { name: "draft_linkedin_post", arguments: { text: "A safe test post", visibility: "PUBLIC" } },
    { name: "revise_post", arguments: { postId: "post-1", text: "A safe revised post" } },
    { name: "get_pmm_brand_profile", arguments: {} },
    {
      name: "create_branded_visual_brief",
      arguments: {
        postId: BRAND_POST_ID,
        expectedVersion: 1,
        coverHook: "Clarity beats capability.",
        conceptSummary: "Restrained editorial geometry about choosing clarity",
        visualMode: "EDITORIAL_STATEMENT",
        topicLabel: "POSITIONING"
      }
    },
    {
      name: "render_branded_linkedin_cover",
      arguments: {
        briefId: BRAND_BRIEF_ID,
        postId: BRAND_POST_ID,
        expectedVersion: 1,
        altText: "Editorial PMM Field Notes cover about product clarity."
      }
    },
    {
      name: "attach_linkedin_post_images",
      arguments: {
        postId: "123e4567-e89b-12d3-a456-426614174001",
        expectedVersion: 1,
        images: [{ download_url: "https://files.example/image.png", file_id: "file-1" }],
        altTexts: ["A product dashboard"]
      }
    },
    {
      name: "set_linkedin_post_images",
      arguments: {
        postId: "123e4567-e89b-12d3-a456-426614174001",
        expectedVersion: 1,
        media: []
      }
    },
    {
      name: "open_linkedin_review_card",
      arguments: { postId: "123e4567-e89b-12d3-a456-426614174001", version: 1 }
    },
    { name: "create_exact_linkedin_preview", arguments: { postId: "post-1", version: 1 } },
    { name: "create_weekly_shortlist", arguments: { name: "This week", targetIds: ["target-1"] } },
    { name: "save_target", arguments: { target } },
    { name: "update_outreach_status", arguments: { targetId: "target-1", status: "shortlisted" } },
    { name: "list_pipeline", arguments: {} },
    { name: "record_note", arguments: { targetId: "target-1", text: "Private note" } },
    { name: "list_post_history", arguments: { postId: "post-1" } },
    { name: "get_linkedin_connection_status", arguments: {} },
    { name: "create_linkedin_authorization_url", arguments: {} },
    {
      name: "publish_exact_linkedin_post",
      arguments: { approvalCapability: "A".repeat(43) }
    }
  ];

  for (const call of calls) {
    const result = await client.callTool(call);
    expect(result.isError, call.name).not.toBe(true);
    expect(result.structuredContent, call.name).toHaveProperty("data");
    const textContent = result.content as Array<{ type: string; text?: string }>;
    const summary = textContent.find((item) => item.type === "text")?.text ?? "";
    expect(summary, call.name).not.toBe("Done.");
    expect(summary.length, call.name).toBeGreaterThan(0);
    expect(summary.length, call.name).toBeLessThanOrEqual(240);
  }
  await Promise.all([client.close(), server.close()]);
});

it("requires request auth before any draft-media or Storage action", async () => {
  const attachFiles = vi.fn();
  const setMedia = vi.fn();
  const getVersion = vi.fn();
  const createSignedUrls = vi.fn();
  const createExact = vi.fn();
  const deps = dependencies();
  deps.media = { attachFiles, setMedia, getVersion, createSignedUrls };
  deps.reviews = { createExact };
  const server = createCareerMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  for (const call of [
    {
      name: "attach_linkedin_post_images",
      arguments: {
        postId: "123e4567-e89b-12d3-a456-426614174001",
        expectedVersion: 1,
        images: [{ download_url: "https://files.example/image.png", file_id: "file-1" }],
        altTexts: ["A product dashboard"]
      }
    },
    {
      name: "set_linkedin_post_images",
      arguments: {
        postId: "123e4567-e89b-12d3-a456-426614174001",
        expectedVersion: 1,
        media: []
      }
    },
    {
      name: "open_linkedin_review_card",
      arguments: { postId: "123e4567-e89b-12d3-a456-426614174001", version: 1 }
    },
    {
      name: "create_exact_linkedin_preview",
      arguments: { postId: "123e4567-e89b-12d3-a456-426614174001", version: 1 }
    },
    {
      name: "get_pmm_brand_profile",
      arguments: {}
    },
    {
      name: "create_branded_visual_brief",
      arguments: {
        postId: BRAND_POST_ID,
        expectedVersion: 1,
        coverHook: "Clarity beats capability.",
        conceptSummary: "Restrained editorial geometry about choosing clarity",
        visualMode: "EDITORIAL_STATEMENT"
      }
    },
    {
      name: "render_branded_linkedin_cover",
      arguments: {
        briefId: BRAND_BRIEF_ID,
        postId: BRAND_POST_ID,
        expectedVersion: 1,
        altText: "Editorial PMM Field Notes cover about product clarity."
      }
    }
  ]) {
    const result = await client.callTool(call);
    expect(result.isError, call.name).toBe(true);
    expect(result.structuredContent, call.name).toEqual({
      data: { error: { code: "AUTH_REQUIRED" } }
    });
  }
  await Promise.all([client.close(), server.close()]);

  expect(attachFiles).not.toHaveBeenCalled();
  expect(setMedia).not.toHaveBeenCalled();
  expect(getVersion).not.toHaveBeenCalled();
  expect(createSignedUrls).not.toHaveBeenCalled();
  expect(createExact).not.toHaveBeenCalled();
});

it("returns only model-safe Brand Studio values and never leaks service internals", async () => {
  const deps = successfulDependencies();
  const secret = "private-secret-that-must-not-leak";
  const brandResult = await deps.brand!.createBrief({
    postId: BRAND_POST_ID,
    expectedVersion: 1,
    coverHook: "Clarity beats capability.",
    conceptSummary: "Restrained editorial geometry about choosing clarity",
    visualMode: "EDITORIAL_STATEMENT"
  });
  deps.brand = {
    ...deps.brand!,
    createBrief: async () => ({
      ...brandResult,
      brief: {
        ...brandResult.brief,
        objectPath: `owner/${secret}/source.png`,
        signedUrl: `https://storage.example/${secret}`,
        approvalCapability: secret
      }
    })
  };
  const renderResult = await deps.brandRenderer!.render({
    briefId: BRAND_BRIEF_ID,
    postId: BRAND_POST_ID,
    expectedVersion: 1,
    altText: "Editorial PMM Field Notes cover about product clarity."
  });
  deps.brandRenderer = {
    render: async () => ({
      ...renderResult,
      objectPath: `owner/${secret}/render.png`,
      sourceDownloadUrl: `https://files.example/${secret}`,
      jwt: secret,
      fontPath: `/private/fonts/${secret}.woff2`,
      approvalCapability: secret
    })
  };
  const server = createCareerMcpServer(deps, {
    requestAuthContext: Object.freeze({
      subject: "123e4567-e89b-12d3-a456-426614174000",
      accessToken: secret
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const brief = await client.callTool({
    name: "create_branded_visual_brief",
    arguments: {
      postId: BRAND_POST_ID,
      expectedVersion: 1,
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry about choosing clarity",
      visualMode: "EDITORIAL_STATEMENT"
    }
  });
  const render = await client.callTool({
    name: "render_branded_linkedin_cover",
    arguments: {
      briefId: BRAND_BRIEF_ID,
      postId: BRAND_POST_ID,
      expectedVersion: 1,
      altText: "Editorial PMM Field Notes cover about product clarity."
    }
  });
  await Promise.all([client.close(), server.close()]);

  expect(createBrandedVisualBriefOutput.safeParse(brief.structuredContent).success).toBe(true);
  expect(renderBrandedLinkedInCoverOutput.safeParse(render.structuredContent).success).toBe(true);
  const serialized = JSON.stringify({ brief, render });
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toMatch(/objectPath|signedUrl|sourceDownloadUrl|jwt|fontPath|approvalCapability/);
  expect(serialized).toContain("generationPrompt");
  expect(serialized).toContain("negativeConstraints");
  expect(serialized).toContain("validationPassed");
});

it("keeps exact-preview capabilities and signed URLs widget-private", async () => {
  const approvalCapability = "Z".repeat(43);
  const requestBearer = "private-request-bearer-that-must-not-leak";
  const signedMediaUrls = [{
    position: 0,
    url: "https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/image"
  }];
  const preview = {
    postId: "123e4567-e89b-12d3-a456-426614174001",
    versionId: "123e4567-e89b-12d3-a456-426614174002",
    text: "The full exact post text",
    version: 2,
    checksum: "a".repeat(64),
    visibility: "CONNECTIONS" as const,
    characterCount: 24,
    media: [{
      position: 0,
      mediaId: "123e4567-e89b-12d3-a456-426614174003",
      altText: "A launch dashboard",
      sha256: "b".repeat(64),
      mimeType: "image/png" as const,
      byteSize: 123,
      width: 640,
      height: 480,
      frameCount: 1,
      originalFilename: "launch.png",
      createdAt: FIXED_NOW.toISOString()
    }],
    expiresAt: "2026-07-17T00:15:00.000Z"
  };
  const deps = dependencies();
  deps.reviews = {
    createExact: vi.fn(async () => ({ preview, approvalCapability, signedMediaUrls }))
  };
  const server = createCareerMcpServer(deps, {
    requestAuthContext: Object.freeze({
      subject: "123e4567-e89b-12d3-a456-426614174000",
      accessToken: requestBearer
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "create_exact_linkedin_preview",
    arguments: { postId: preview.postId, version: preview.version }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ data: { preview } });
  expect(result.structuredContent).not.toHaveProperty("approvalCapability");
  expect(result._meta).toEqual({ approvalCapability, signedMediaUrls });
  expect(JSON.stringify(result.structuredContent)).not.toContain(approvalCapability);
  expect(JSON.stringify(result.structuredContent)).not.toContain("supabase.co");
  expect(JSON.stringify(result.content)).not.toContain(approvalCapability);
  expect(JSON.stringify(result.content)).not.toContain("supabase.co");
  expect(JSON.stringify(result)).not.toContain(requestBearer);
});

it("opens a non-writing review card and keeps signed URLs widget-private", async () => {
  const timestamp = FIXED_NOW.toISOString();
  const post = {
    id: "123e4567-e89b-12d3-a456-426614174001",
    versionId: "123e4567-e89b-12d3-a456-426614174002",
    text: "Exact private text",
    visibility: "CONNECTIONS" as const,
    version: 2,
    checksum: "b".repeat(64),
    state: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    media: [{
      position: 0,
      mediaId: "123e4567-e89b-12d3-a456-426614174003",
      altText: "A launch dashboard",
      sha256: "c".repeat(64),
      mimeType: "image/png" as const,
      byteSize: 123,
      width: 640,
      height: 480,
      frameCount: 1,
      originalFilename: "launch.png",
      createdAt: timestamp
    }]
  };
  const previewCreate = vi.fn();
  const getProvenanceForMedia = vi.fn(async () => ({
    seriesName: "PMM FIELD NOTES",
    profileVersion: 1,
    templateId: "editorial-statement-v1",
    templateVersion: 1,
    coverHook: "Clarity beats capability.",
    renderChecksum: "d".repeat(64),
    validationPassed: true,
    sourceMediaId: "private-source-media-id",
    objectPath: "private/source.png",
    signedUrl: "https://project.supabase.co/private-source"
  }));
  const deps = dependencies();
  deps.previews.create = previewCreate;
  deps.brand = {
    getProfile: vi.fn(),
    createBrief: vi.fn(),
    getProvenanceForMedia
  };
  deps.media = {
    attachFiles: vi.fn(),
    setMedia: vi.fn(),
    getVersion: vi.fn(async () => post),
    createSignedUrls: vi.fn(async () => ["https://project.supabase.co/storage/v1/object/sign/private"])
  };
  const server = createCareerMcpServer(deps, {
    requestAuthContext: Object.freeze({
      subject: "123e4567-e89b-12d3-a456-426614174000",
      accessToken: "request-token-that-must-not-leak"
    })
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "open_linkedin_review_card",
    arguments: { postId: post.id, version: post.version }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    data: {
      post,
      brand: {
        seriesName: "PMM FIELD NOTES",
        profileVersion: 1,
        templateId: "editorial-statement-v1",
        templateVersion: 1,
        coverHook: "Clarity beats capability.",
        renderChecksum: "d".repeat(64),
        validationPassed: true
      }
    }
  });
  expect(getProvenanceForMedia).toHaveBeenCalledOnce();
  expect(getProvenanceForMedia).toHaveBeenCalledWith(post.media[0]?.mediaId);
  expect(result._meta).toEqual({
    mediaUrls: ["https://project.supabase.co/storage/v1/object/sign/private"]
  });
  expect(JSON.stringify(result.structuredContent)).not.toContain("supabase.co");
  expect(JSON.stringify(result.structuredContent)).not.toContain("private-source-media-id");
  expect(JSON.stringify(result.structuredContent)).not.toContain("private/source.png");
  expect(JSON.stringify(result.content)).not.toContain("supabase.co");
  expect(JSON.stringify(result)).not.toContain("request-token-that-must-not-leak");
  expect(previewCreate).not.toHaveBeenCalled();
});

it("reports the independent image-publishing switch as a boolean only", async () => {
  const deps = dependencies();
  deps.getLinkedInConnectionStatus = async () => ({
    connected: true,
    valid: true,
    publishingEnabled: false,
    imagePublishingEnabled: false
  });
  const server = createCareerMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "get_linkedin_connection_status", arguments: {} });
  await Promise.all([client.close(), server.close()]);

  expect(result.structuredContent).toEqual({
    data: {
      connection: {
        connected: true,
        valid: true,
        publishingEnabled: false,
        imagePublishingEnabled: false
      }
    }
  });
  expect(JSON.stringify(result)).not.toContain("LINKEDIN_IMAGE_PUBLISH_ENABLED");
});

it("makes publishing, research, and branded-cover safety rules prominent in instructions", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const instructions = client.getInstructions() ?? "";
  await Promise.all([client.close(), server.close()]);
  expect(instructions.slice(0, 512)).toContain("Never fetch LinkedIn for research");
  expect(instructions.slice(0, 512)).toContain("Never claim complete employee coverage");
  expect(instructions.slice(0, 512)).toContain("current user explicitly asks to publish the exact preview");
  expect(instructions.slice(0, 512)).toContain("Never batch or retry publishing");
  expect(instructions).toContain("curiosity covers, not post summaries");
  expect(instructions).toContain("source art must contain no text");
});

it("serves MCP initialization through stateless Streamable HTTP", async () => {
  const response = await request(createHttpApp({ mcpServerFactory: () => createCareerMcpServer(dependencies()) }))
    .post("/mcp")
    .set("accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });
  expect(response.status).toBe(200);
  expect(response.text).toContain('"name":"pmm-career-mcp"');
  expect(response.headers["mcp-session-id"]).toBeUndefined();
});

it("closes the stateless MCP server once after a Streamable HTTP response completes", async () => {
  const server = createCareerMcpServer(dependencies());
  const close = vi.spyOn(server, "close");
  const response = await request(createHttpApp({ mcpServerFactory: () => server }))
    .post("/mcp")
    .set("accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("reports page-scoped YC coverage even when a filtered search is empty", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "search_yc_companies",
    arguments: { keyword: "outside-the-fetched-facet" }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.structuredContent).toMatchObject({
    data: {
      companies: [],
      coverageSummary: {
        coverage: "authoritative-page-only",
        complete: false,
        sourceUrl: "https://www.ycombinator.com/companies/industry/marketing"
      }
    }
  });
  expect(JSON.stringify(result.structuredContent)).toContain(
    "An empty result is not proof that no matching YC company exists"
  );
});

it("returns a safe tool error without exposing an implementation message", async () => {
  const server = createCareerMcpServer(dependencies());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "A safe test post", visibility: "PUBLIC" }
  });
  await Promise.all([client.close(), server.close()]);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("not called");
});

it("waits for a database-backed service promise before returning a tool result", async () => {
  const post = deferred<{
    id: string;
    versionId: string;
    text: string;
    visibility: "PUBLIC";
    version: number;
    checksum: string;
    state: string;
    createdAt: string;
    updatedAt: string;
    media: [];
  }>();
  const started = deferred<void>();
  const asyncDependencies = dependencies();
  asyncDependencies.drafts.createPost = (() => {
    started.resolve();
    return post.promise;
  }) as unknown as CareerMcpDependencies["drafts"]["createPost"];
  const server = createCareerMcpServer(asyncDependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let settled = false;
  const resultPromise = client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "An asynchronously saved post", visibility: "PUBLIC" }
  }).then((result) => {
    settled = true;
    return result;
  });
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  post.resolve({
    id: "saved-post",
    versionId: "saved-post-version",
    text: "An asynchronously saved post",
    visibility: "PUBLIC",
    version: 1,
    checksum: "a".repeat(64),
    state: "draft",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    media: []
  });
  const result = await resultPromise;
  await Promise.all([client.close(), server.close()]);
  expect(result.structuredContent).toMatchObject({ data: { post: { id: "saved-post" } } });
});

it("turns a rejected database-backed service promise into a safe tool error", async () => {
  const asyncDependencies = dependencies();
  asyncDependencies.drafts.createPost = (async () => {
    throw new Error("database-connection-secret");
  }) as CareerMcpDependencies["drafts"]["createPost"];
  const server = createCareerMcpServer(asyncDependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "draft_linkedin_post",
    arguments: { text: "A safely failed post", visibility: "PUBLIC" }
  });
  await Promise.all([client.close(), server.close()]);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ data: { error: { code: "DATA_INTEGRITY" } } });
  expect(JSON.stringify(result)).not.toContain("database-connection-secret");
});

it("keeps safe tool errors schema-valid over Streamable HTTP", async () => {
  const failingDependencies: CareerMcpDependencies = {
    ...dependencies(),
    ycProvider: { searchYcCompanies: async () => { throw new Error("provider-secret-detail"); } }
  };
  const listener = createHttpApp({ mcpServerFactory: () => createCareerMcpServer(failingDependencies) }).listen(0);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)) as never);
    const result = await client.callTool({ name: "search_yc_companies", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ data: { error: { code: "DATA_INTEGRITY" } } });
    expect(JSON.stringify(result)).not.toContain("provider-secret-detail");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
