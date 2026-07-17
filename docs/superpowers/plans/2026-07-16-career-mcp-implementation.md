# Career MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a private hosted MCP server that lets one ChatGPT user research and rank YC networking targets, save outreach and post drafts, track progress, and publish an exact approved text post through LinkedIn's official API.

**Architecture:** A TypeScript/Node streaming-HTTP MCP server exposes small tools backed by a single-user SQLite database. Domain services isolate research, ranking, pipeline, draft safety, OAuth, and LinkedIn posting; production uses OAuth 2.1 and an HTTPS container host, while development uses a secure tunnel and mocked external services.

**Tech Stack:** Node.js 22+, TypeScript, @modelcontextprotocol/sdk, Express, Zod, Drizzle ORM, better-sqlite3, Cheerio, jose, Pino, Vitest, Supertest, Nock, Docker.

## Global Constraints

- One private user and one LinkedIn account.
- ChatGPT Developer Mode is the primary client.
- Production transport is streaming HTTP over HTTPS at /mcp.
- Production authentication is OAuth 2.1 and must allow only the configured subject.
- Local AUTH_MODE=none is permitted only outside production.
- Research is limited to YC companies and permitted public sources.
- Never fetch or automate linkedin.com pages for research.
- Never send connection requests or LinkedIn messages.
- Publishing supports text posts only in version 1.
- LINKEDIN_PUBLISH_ENABLED defaults to false.
- Publishing requires the exact saved version, checksum, fresh one-use 15-minute preview token, and a ChatGPT write confirmation.
- Never retry an ambiguous LinkedIn create-post result automatically.
- No autonomous posting, scheduled publishing, multi-user support, or background cron in version 1.
- Write tests before implementation, run focused tests after every change, and commit every completed task.

---

## File map

- package.json — scripts and dependency manifest.
- tsconfig.json — strict TypeScript configuration.
- vitest.config.ts — test and coverage configuration.
- drizzle.config.ts — migration generation configuration.
- .env.example — documented, non-secret configuration.
- src/index.ts — process entry point and graceful shutdown.
- src/config.ts — environment parsing and production safety validation.
- src/http/app.ts — Express app, health route, OAuth callbacks, and /mcp transport.
- src/mcp/server.ts — MCP instructions, tool registration, and annotations.
- src/mcp/schemas.ts — shared Zod input/output schemas.
- src/auth/resource-auth.ts — OAuth protected-resource metadata and JWT validation.
- src/db/client.ts — SQLite connection and migration startup.
- src/db/schema.ts — Drizzle tables and exported row types.
- src/db/repositories.ts — focused persistence operations used by domain services.
- src/security/crypto.ts — authenticated encryption for provider tokens.
- src/security/redact.ts — structured-log redaction.
- src/research/url-policy.ts — SSRF, LinkedIn, redirect, content-type, and size rules.
- src/research/fetch-page.ts — safe HTTP fetching and text extraction.
- src/research/yc-provider.ts — YC company import/search.
- src/research/people-discovery.ts — public team/person evidence extraction.
- src/research/job-discovery.ts — PMM and adjacent job/hiring-signal extraction.
- src/research/search-provider.ts — optional wider public-search adapter contract.
- src/research/types.ts — company, person, evidence, and freshness types.
- src/ranking/score-target.ts — transparent three-component scoring.
- src/pipeline/service.ts — targets, statuses, notes, and shortlists.
- src/drafts/service.ts — outreach and versioned post drafts.
- src/posts/preview-service.ts — checksums and one-use preview tokens.
- src/linkedin/oauth.ts — LinkedIn authorization URL and callback exchange.
- src/linkedin/posts-client.ts — versioned LinkedIn Posts API adapter.
- src/linkedin/publish-service.ts — exact-version validation and publish state machine.
- tests/** — unit, integration, contract, and end-to-end tests mirroring src.
- Dockerfile — production image.
- README.md — setup, ChatGPT connection, credentials, safety, and deployment.

## Canonical shared type contracts

Create these contracts in the owning files named above and import them rather than redefining them:

~~~ts
export type Evidence = {
  id: string;
  sourceUrl: string;
  title: string;
  fact: string;
  checkedAt: string;
  confidence: number;
};

export type CompanyResult = {
  id: string;
  ycId: string;
  name: string;
  batch?: string;
  status?: string;
  location?: string;
  hiring?: boolean;
  websiteUrl?: string;
  sources: Evidence[];
};

export type PersonWithEvidence = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  publicProfileUrl?: string;
  evidence: Evidence[];
};

export type Opportunity = {
  id: string;
  companyId: string;
  title: string;
  location?: string;
  sourceUrl: string;
  checkedAt: string;
  active: boolean;
};

export type CareerPreferences = {
  roleKeywords: string[];
  preferredLocations: string[];
  industries: string[];
};

export type RankingWeights = {
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
};

export type TargetScore = {
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
  total: number;
  confidence: number;
  reasons: string[];
  missingEvidence: string[];
};
~~~

### Task 1: Project foundation, configuration, and health endpoint

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: src/config.ts
- Create: src/http/app.ts
- Create: src/index.ts
- Test: tests/config.test.ts
- Test: tests/health.test.ts

**Interfaces:**
- Produces: loadConfig(env: NodeJS.ProcessEnv): AppConfig
- Produces: createHttpApp(deps: HttpDependencies): Express
- Produces: AppConfig with port, nodeEnv, databasePath, baseUrl, authMode, allowedSubject, linkedinPublishEnabled, linkedinVersion.

- [ ] **Step 1: Install the foundation dependencies and create strict compiler/test configuration**

Run:

~~~bash
npm init -y
npm install @modelcontextprotocol/sdk express zod pino
npm install -D typescript tsx vitest @vitest/coverage-v8 supertest @types/express @types/node @types/supertest
~~~

Set package scripts to:

~~~json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/src/index.js",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  }
}
~~~

Create tsconfig.json:

~~~json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "drizzle.config.ts"]
}
~~~

Create vitest.config.ts:

~~~ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
~~~

Expected: package-lock.json is created and npm test can start Vitest.

- [ ] **Step 2: Write failing configuration tests**

Create tests/config.test.ts:

~~~ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps publishing disabled by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.linkedinPublishEnabled).toBe(false);
  });

  it("rejects no-auth production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AUTH_MODE: "none",
      TOKEN_ENCRYPTION_KEY: "x".repeat(64)
    })).toThrow(/AUTH_MODE/);
  });
});
~~~

- [ ] **Step 3: Run the focused test and verify failure**

Run: npm test -- tests/config.test.ts  
Expected: FAIL because src/config.ts does not exist.

- [ ] **Step 4: Implement minimal validated configuration**

Create src/config.ts with a Zod environment schema and this exported shape:

~~~ts
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
  const nodeEnv = (env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const authMode = (env.AUTH_MODE ?? "none") as AppConfig["authMode"];
  if (nodeEnv === "production" && authMode !== "oauth") {
    throw new Error("AUTH_MODE must be oauth in production");
  }
  return {
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/career-mcp.sqlite",
    baseUrl: env.BASE_URL ?? "http://127.0.0.1:3000",
    authMode,
    allowedSubject: env.ALLOWED_SUBJECT,
    linkedinPublishEnabled: env.LINKEDIN_PUBLISH_ENABLED === "true",
    linkedinVersion: env.LINKEDIN_VERSION ?? "202606",
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY
  };
}
~~~

- [ ] **Step 5: Add and test the health endpoint**

Create tests/health.test.ts first:

~~~ts
import request from "supertest";
import { expect, it } from "vitest";
import { createHttpApp } from "../src/http/app.js";

it("returns a non-sensitive health response", async () => {
  const response = await request(createHttpApp({ mcpHandler: (_req, res) => res.sendStatus(501) })).get("/health");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok" });
});
~~~

Implement createHttpApp with GET /health and an injected /mcp handler. Run: npm test -- tests/config.test.ts tests/health.test.ts  
Expected: PASS.

- [ ] **Step 6: Add the process entry point and verify build**

src/index.ts loads config, creates the app, listens on config.port, and handles SIGTERM/SIGINT without logging environment values.

Run: npm run typecheck && npm run build  
Expected: both commands exit 0.

- [ ] **Step 7: Commit**

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src tests
git commit -m "feat: scaffold Career MCP server"
~~~

### Task 2: SQLite schema, migrations, and repositories

**Files:**
- Create: drizzle.config.ts
- Create: src/db/schema.ts
- Create: src/db/client.ts
- Create: src/db/repositories.ts
- Create: drizzle/0000_initial.sql
- Test: tests/db/repositories.test.ts

**Interfaces:**
- Consumes: AppConfig.databasePath.
- Produces: createDatabase(path: string): CareerDatabase
- Produces: close(): void and repository methods for companies, people, evidence, targets, notes, shortlists, drafts, previews, publish attempts, and encrypted tokens.

- [ ] **Step 1: Install SQLite and Drizzle**

Run:

~~~bash
npm install drizzle-orm better-sqlite3
npm install -D drizzle-kit @types/better-sqlite3
~~~

- [ ] **Step 2: Write a failing repository persistence test**

Create tests/db/repositories.test.ts:

~~~ts
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";

const db = createDatabase(":memory:");
afterEach(() => db.resetForTests());

it("persists a target with evidence provenance", () => {
  const company = db.companies.upsert({ ycId: "acme-w24", name: "Acme", batch: "W24" });
  const person = db.people.upsert({ companyId: company.id, name: "Ada Example", role: "Founder" });
  db.evidence.add({ personId: person.id, sourceUrl: "https://acme.example/team", fact: "Founder", checkedAt: "2026-07-16T00:00:00.000Z", confidence: 0.9 });
  expect(db.people.getWithEvidence(person.id)?.evidence).toHaveLength(1);
});
~~~

- [ ] **Step 3: Run the test and verify failure**

Run: npm test -- tests/db/repositories.test.ts  
Expected: FAIL because createDatabase is missing.

- [ ] **Step 4: Define the Drizzle schema**

Create tables named settings, companies, people, evidence, targets, target_notes, outreach_drafts, shortlists, shortlist_entries, post_drafts, post_previews, publish_attempts, and oauth_tokens. Use text UUID primary keys, ISO timestamp text, foreign keys, and unique indexes for YC ID, company-person identity, post version, and preview token hash.

The post preview definition must include:

~~~ts
export const postPreviews = sqliteTable("post_previews", {
  id: text("id").primaryKey(),
  postDraftId: text("post_draft_id").notNull().references(() => postDrafts.id),
  version: integer("version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at")
});
~~~

- [ ] **Step 5: Implement database creation and repository methods**

createDatabase must enable foreign_keys and WAL for file databases, apply migrations, expose repositories, and provide resetForTests only when path is :memory:.

Use transaction boundaries for draft-version creation, preview consumption, and publish-attempt recording.

- [ ] **Step 6: Run schema and repository verification**

Run:

~~~bash
npx drizzle-kit generate
npm test -- tests/db/repositories.test.ts
npm run typecheck
~~~

Expected: migration is generated, test PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

~~~bash
git add drizzle.config.ts drizzle src/db tests/db package.json package-lock.json
git commit -m "feat: add persistent Career MCP data model"
~~~

### Task 3: Safe public-page fetcher

**Files:**
- Create: src/research/url-policy.ts
- Create: src/research/fetch-page.ts
- Test: tests/research/url-policy.test.ts
- Test: tests/research/fetch-page.test.ts

**Interfaces:**
- Produces: assertFetchableUrl(url: URL, resolvedAddresses: string[]): void
- Produces: fetchPublicPage(url: string, options?: FetchPageOptions): Promise<FetchedPage>
- Produces: FetchedPage { url, title, text, checkedAt, contentType }.

- [ ] **Step 1: Install parsing and HTTP-mocking dependencies**

Run:

~~~bash
npm install cheerio
npm install -D nock
~~~

- [ ] **Step 2: Write failing URL-policy tests**

~~~ts
import { expect, it } from "vitest";
import { assertFetchableUrl } from "../../src/research/url-policy.js";

it.each([
  ["https://www.linkedin.com/in/example", ["108.174.10.10"]],
  ["http://127.0.0.1/admin", ["127.0.0.1"]],
  ["http://169.254.169.254/latest/meta-data", ["169.254.169.254"]]
])("rejects unsafe target %s", (raw, addresses) => {
  expect(() => assertFetchableUrl(new URL(raw), addresses)).toThrow();
});

it("allows a public company HTTPS page", () => {
  expect(() => assertFetchableUrl(new URL("https://acme.example/team"), ["93.184.216.34"])).not.toThrow();
});
~~~

- [ ] **Step 3: Run test and verify failure**

Run: npm test -- tests/research/url-policy.test.ts  
Expected: FAIL because url-policy.ts is missing.

- [ ] **Step 4: Implement URL validation**

Reject non-HTTP(S), credentials in URLs, linkedin.com and subdomains, localhost names, IPv4 private/link-local/loopback ranges, IPv6 loopback/link-local/unique-local ranges, and any redirect that resolves differently into a forbidden address.

- [ ] **Step 5: Write failing fetch/extraction tests**

Mock a valid HTML team page and verify scripts, forms, hidden elements, and instruction-like text are excluded from normalized output. Mock oversized, wrong-content-type, redirect-to-private, timeout, and 429 responses.

The positive assertion must resemble:

~~~ts
expect(result).toMatchObject({
  url: "https://acme.example/team",
  title: "Team",
  contentType: "text/html"
});
expect(result.text).toContain("Ada Example — Founder");
expect(result.text).not.toContain("ignore previous instructions");
~~~

- [ ] **Step 6: Implement bounded fetching**

Use AbortSignal.timeout, manual redirect handling with revalidation, a 2 MB default byte ceiling, content-type allowlist, per-host concurrency limit, Retry-After parsing for research GET requests, Cheerio extraction, and an untrusted-data marker in the returned type.

- [ ] **Step 7: Verify and commit**

Run:

~~~bash
npm test -- tests/research
npm run typecheck
git add src/research tests/research package.json package-lock.json
git commit -m "feat: add safe public research fetcher"
~~~

Expected: tests PASS and commit succeeds.

### Task 4: YC companies and public-person discovery

**Files:**
- Create: src/research/types.ts
- Create: src/research/yc-provider.ts
- Create: src/research/people-discovery.ts
- Create: src/research/job-discovery.ts
- Create: src/research/search-provider.ts
- Test: tests/research/yc-provider.test.ts
- Test: tests/research/people-discovery.test.ts
- Test: tests/research/job-discovery.test.ts
- Fixture: tests/fixtures/yc-company.html
- Fixture: tests/fixtures/company-team.html
- Fixture: tests/fixtures/company-careers.html

**Interfaces:**
- Consumes: fetchPublicPage and database repositories.
- Produces: searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]>
- Produces: discoverPublicPeople(companyId: string): Promise<DiscoveryResult>
- Produces: findPmmOpportunities(companyIds: string[], preferences: CareerPreferences): Promise<Opportunity[]>
- Produces: SearchProvider.search(query: string, limit: number): Promise<SearchResult[]>
- DiscoveryResult includes people, evidence, checkedAt, coverage: "authoritative-pages-only" | "search-extended".

- [ ] **Step 1: Write failing fixture-based provider tests**

Test that the YC fixture produces stable company records with YC source URLs and that filtering by batch, keyword, location, status, and hiring flag is deterministic.

~~~ts
const results = await provider.search({ batch: "W24", keyword: "AI", hiring: true });
expect(results.map((item) => item.name)).toEqual(["Acme AI"]);
expect(results[0]?.sources[0]?.url).toMatch(/^https:\/\/www\.ycombinator\.com\//);
~~~

- [ ] **Step 2: Run and verify failure**

Run: npm test -- tests/research/yc-provider.test.ts  
Expected: FAIL because provider/types are missing.

- [ ] **Step 3: Implement YC normalization and filtering**

Do not depend on undocumented JSON endpoints. Parse public HTML behind a YcSource interface so fixture and live implementations share normalizeCompany(raw): CompanyResult. If YC layout cannot be parsed, return a source-changed error rather than empty success.

- [ ] **Step 4: Write failing public-person discovery tests**

Use company-team.html containing founders, marketers, recruiters, and engineers. Assert every discovered person has a role, company ID, source URL, checkedAt, and confidence; assert duplicate name/role pairs collapse; assert coverage is authoritative-pages-only without a search adapter.

- [ ] **Step 5: Implement discovery**

Start with official company team/leadership/about pages discovered from the stored company website. Store short normalized evidence facts, not entire pages. Never fabricate a LinkedIn URL; retain one only if an official public page explicitly links to it without fetching it.

- [ ] **Step 6: Write failing PMM-opportunity tests**

Use company-careers.html with Product Marketing Manager, Growth Marketing, unrelated engineering, closed, and duplicate roles. Verify Product Marketing and configured adjacent keywords are returned, closed and duplicate roles are excluded, each result cites the official job URL and checkedAt, and source failure is returned as a partial warning.

~~~ts
const opportunities = await findPmmOpportunities([company.id], {
  roleKeywords: ["product marketing", "growth marketing"],
  preferredLocations: ["San Francisco", "Remote"],
  industries: ["AI"]
});
expect(opportunities.map((item) => item.title)).toEqual([
  "Growth Marketing Lead",
  "Product Marketing Manager"
]);
~~~

- [ ] **Step 7: Implement job discovery and optional search contract**

Parse official careers pages first. search-provider.ts exports only an interface plus DisabledSearchProvider, whose search method returns an empty list and coverage authoritative-pages-only. Do not add a third-party search dependency in version 1.

- [ ] **Step 8: Verify and commit**

Run:

~~~bash
npm test -- tests/research
npm run typecheck
git add src/research tests/research tests/fixtures
git commit -m "feat: discover YC companies people and PMM opportunities"
~~~

### Task 5: Transparent target ranking

**Files:**
- Create: src/ranking/score-target.ts
- Test: tests/ranking/score-target.test.ts

**Interfaces:**
- Consumes: PersonWithEvidence, Opportunity[], CareerPreferences, RankingWeights.
- Produces: scoreTarget(input: ScoreTargetInput): TargetScore.
- Produces: explainTargetMatch(score: TargetScore): { reasons: string[]; missingEvidence: string[] }.
- TargetScore contains pmmOpportunity, referralPotential, networkValue, total, confidence, reasons, missingEvidence.

- [ ] **Step 1: Write failing scoring tests**

~~~ts
it("exposes three components and lowers confidence for stale evidence", () => {
  const fresh = scoreTarget(fixture({ checkedAt: "2026-07-15T00:00:00.000Z" }), NOW);
  const stale = scoreTarget(fixture({ checkedAt: "2025-01-01T00:00:00.000Z" }), NOW);
  expect(fresh.total).toBe(fresh.pmmOpportunity + fresh.referralPotential + fresh.networkValue);
  expect(stale.confidence).toBeLessThan(fresh.confidence);
  expect(stale.missingEvidence).toContain("fresh company evidence");
});
~~~

- [ ] **Step 2: Run and verify failure**

Run: npm test -- tests/ranking/score-target.test.ts  
Expected: FAIL because scoreTarget is missing.

- [ ] **Step 3: Implement deterministic scoring**

Normalize configurable weights to 1.0. Each component returns 0–100 before weighting. Base reasons only on typed evidence flags such as activePmmRole, companyHiring, roleSeniority, sharedDomain, locationMatch, and recentFundingSignal. Missing evidence produces zero contribution and a named missing-evidence item.

- [ ] **Step 4: Add boundary and property tests**

Assert total is always 0–100, confidence is 0–1, input order does not change output, equal scores use company/name stable sorting, and no reason mentions a fact absent from evidence.

- [ ] **Step 5: Verify and commit**

Run: npm test -- tests/ranking && npm run typecheck  
Expected: PASS.

~~~bash
git add src/ranking tests/ranking
git commit -m "feat: add evidence-backed target ranking"
~~~

### Task 6: Private pipeline and drafting services

**Files:**
- Create: src/pipeline/service.ts
- Create: src/drafts/service.ts
- Test: tests/pipeline/service.test.ts
- Test: tests/drafts/service.test.ts

**Interfaces:**
- Consumes: database repositories and TargetScore.
- Produces: PipelineService.saveTarget, updateStatus, recordNote, listPipeline, createShortlist.
- Produces: DraftService.createOutreach, createPost, revisePost, getPostHistory.

- [ ] **Step 1: Write failing pipeline tests**

Verify statuses are limited to discovered, shortlisted, connect_planned, connected, contacted, replied, archived; notes append rather than overwrite; shortlist ordering persists; listing can filter by company and status.

- [ ] **Step 2: Implement the minimal pipeline service**

Every mutation returns the saved object with id and updatedAt. Unknown IDs and invalid status transitions return typed DomainError values, not database errors.

- [ ] **Step 3: Write failing draft-version tests**

~~~ts
it("revising a post creates an immutable next version", () => {
  const first = drafts.createPost({ text: "First", visibility: "PUBLIC" });
  const second = drafts.revisePost(first.id, "Second");
  expect(second.version).toBe(2);
  expect(drafts.getPostVersion(first.id, 1)?.text).toBe("First");
  expect(drafts.getPostVersion(first.id, 2)?.text).toBe("Second");
});
~~~

- [ ] **Step 4: Implement drafting**

Outreach drafts require target evidence IDs and a purpose. Post drafts store text, visibility, version, SHA-256 checksum, state draft, and timestamps. Reject empty text and unsupported media.

- [ ] **Step 5: Verify and commit**

Run: npm test -- tests/pipeline tests/drafts && npm run typecheck  
Expected: PASS.

~~~bash
git add src/pipeline src/drafts tests/pipeline tests/drafts
git commit -m "feat: add private networking pipeline and drafts"
~~~

### Task 7: Preview tokens, encrypted credentials, and publish state machine

**Files:**
- Create: src/security/crypto.ts
- Create: src/security/redact.ts
- Create: src/posts/preview-service.ts
- Create: src/linkedin/publish-service.ts
- Test: tests/security/crypto.test.ts
- Test: tests/posts/preview-service.test.ts
- Test: tests/linkedin/publish-service.test.ts

**Interfaces:**
- Produces: encryptJson(value, key): EncryptedEnvelope and decryptJson(envelope, key).
- Produces: PreviewService.create(postId, version): PreviewResult and consume(token, expected): void.
- Consumes: LinkedInPostsClient.createTextPost.
- Produces: PublishService.publish(input): Promise<PublishResult>.

- [ ] **Step 1: Write failing encryption tests**

Test AES-256-GCM round trip, unique nonces, wrong-key failure, tamper failure, and redaction of authorization, access_token, refresh_token, client_secret, state, and previewToken fields.

- [ ] **Step 2: Implement encryption and redaction**

Derive a 32-byte key from the 64-character hex TOKEN_ENCRYPTION_KEY. Store version, IV, auth tag, and ciphertext. Never log plaintext or full encrypted envelopes.

- [ ] **Step 3: Write failing preview-token tests**

Use an injected clock and random-byte provider. Assert tokens are stored only as SHA-256 hashes, expire at 15 minutes, are consumed once, reject replay, and fail after the post is revised.

- [ ] **Step 4: Implement PreviewService**

create returns exact text, version, checksum, visibility, characterCount, previewToken, expiresAt. consume performs a transaction that verifies hash, expiry, version/checksum, and consumedAt before marking consumed.

- [ ] **Step 5: Write the publish-state tests before the client exists**

Cover disabled kill switch, missing token, expired token, modified draft, successful publish, definite 4xx failure, timeout/ambiguous result, and proof that publish_unknown has no automatic retry.

The core success assertion:

~~~ts
const result = await service.publish(inputFor(preview));
expect(result).toEqual({ state: "published", postUrn: "urn:li:share:123" });
expect(client.createTextPost).toHaveBeenCalledTimes(1);
~~~

- [ ] **Step 6: Implement PublishService against a fake client interface**

The service verifies config, consumes the preview token, records an attempt before the network call, then maps results to published, publish_failed, or publish_unknown. It never loops around createTextPost.

- [ ] **Step 7: Verify and commit**

Run: npm test -- tests/security tests/posts tests/linkedin/publish-service.test.ts && npm run typecheck  
Expected: PASS.

~~~bash
git add src/security src/posts src/linkedin/publish-service.ts tests/security tests/posts tests/linkedin
git commit -m "feat: enforce exact-preview publishing safety"
~~~

### Task 8: LinkedIn OAuth and versioned Posts API client

**Files:**
- Create: src/linkedin/oauth.ts
- Create: src/linkedin/posts-client.ts
- Test: tests/linkedin/oauth.test.ts
- Test: tests/linkedin/posts-client.test.ts

**Interfaces:**
- Produces: LinkedInOAuth.createAuthorizationUrl and exchangeCallback.
- Produces: LinkedInPostsClient.createTextPost(input): Promise<{ postUrn: string }>.
- Consumes: encrypted oauth token repository and AppConfig.linkedinVersion.

- [ ] **Step 1: Write failing OAuth tests**

Assert authorization uses state, PKCE where supported, minimum identity scopes plus w_member_social, exact redirect URI, one-use callback state, encrypted token storage, and sanitized provider errors.

- [ ] **Step 2: Implement LinkedIn OAuth**

Use the documented LinkedIn authorization/token endpoints. The callback validates state before exchange, stores author identity plus encrypted token metadata, and never returns tokens to MCP callers.

- [ ] **Step 3: Write failing Posts API client tests**

With Nock, assert one POST to https://api.linkedin.com/rest/posts with Authorization Bearer, Linkedin-Version from config, X-Restli-Protocol-Version 2.0.0, PUBLIC or CONNECTIONS visibility, MAIN_FEED distribution, lifecycleState PUBLISHED, and text commentary. Assert x-restli-id is required.

- [ ] **Step 4: Implement the client with no internal create retry**

Map 400/401/403/422 to definite failure, 429 to rate-limited failure, and timeout/5xx after request dispatch to ambiguous result. Token refresh may retry before post creation, but createTextPost itself executes at most once per PublishService invocation.

- [ ] **Step 5: Verify and commit**

Run: npm test -- tests/linkedin && npm run typecheck  
Expected: PASS.

~~~bash
git add src/linkedin tests/linkedin
git commit -m "feat: integrate official LinkedIn posting API"
~~~

### Task 9: MCP tools, schemas, instructions, and contract tests

**Files:**
- Create: src/mcp/schemas.ts
- Create: src/mcp/server.ts
- Modify: src/http/app.ts
- Test: tests/mcp/tools.test.ts
- Test: tests/mcp/annotations.test.ts

**Interfaces:**
- Consumes all domain services from Tasks 2–8.
- Produces: createCareerMcpServer(deps): McpServer.
- Produces streaming HTTP handling at POST/GET/DELETE /mcp as required by the SDK transport.
- Registers exactly: search_yc_companies, discover_public_people, find_pmm_opportunities, rank_networking_targets, explain_target_match, draft_outreach, draft_linkedin_post, revise_post, preview_post, create_weekly_shortlist, save_target, update_outreach_status, list_pipeline, record_note, list_post_history, get_linkedin_connection_status, create_linkedin_authorization_url, and publish_linkedin_post.

- [ ] **Step 1: Write failing tool-list tests**

Assert the exact tools from the design exist and no connection-request, messaging, profile-edit, scheduling, batch-publish, or LinkedIn-scraping tool exists.

- [ ] **Step 2: Write failing annotation tests**

Research/preview/list tools use readOnlyHint true. Private draft/pipeline writes use readOnlyHint false, openWorldHint false, destructiveHint false. publish_linkedin_post uses readOnlyHint false, openWorldHint true, destructiveHint false. No annotation is null.

- [ ] **Step 3: Implement shared schemas and concise server instructions**

The first 512 instruction characters must state: never fetch LinkedIn for research; never claim complete employee coverage; never call publish_linkedin_post unless the current user explicitly asks to publish the exact preview; never batch or retry publishing.

- [ ] **Step 4: Register tools one intent at a time**

Each tool has a title, precise description, Zod input schema, output schema, annotations, and structuredContent containing only necessary values. Research results include source URL, checkedAt, confidence, and coverage.

- [ ] **Step 5: Add Streamable HTTP transport**

Use the SDK transport at /mcp, fresh server/transport instances per stateless request unless the selected SDK version requires session management, JSON body limits, request IDs, and safe error mapping. Keep /health outside MCP authentication only if it returns exactly { status: "ok" }.

- [ ] **Step 6: Run MCP contract verification**

Run:

~~~bash
npm test -- tests/mcp
npm run typecheck
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --method tools/list
~~~

Expected: tests PASS and Inspector lists only the approved tools.

- [ ] **Step 7: Commit**

~~~bash
git add src/mcp src/http/app.ts tests/mcp
git commit -m "feat: expose Career MCP tool contract"
~~~

### Task 10: Production OAuth protection

**Files:**
- Create: src/auth/resource-auth.ts
- Modify: src/http/app.ts
- Modify: src/config.ts
- Test: tests/auth/resource-auth.test.ts
- Test: tests/auth/http-auth.test.ts

**Interfaces:**
- Produces: protectedResourceMetadata(config): OAuthProtectedResourceMetadata.
- Produces: createResourceAuth(config): Express middleware.
- Consumes OIDC issuer metadata, audience, allowed subject, and jose remote JWKS verification.

- [ ] **Step 1: Install and test JWT validation**

Run: npm install jose

Write tests using a local generated keypair and mocked JWKS. Assert valid issuer/audience/subject passes; missing bearer, wrong audience, expired token, and wrong subject return 401/403 without leaking claims.

- [ ] **Step 2: Implement protected-resource metadata**

Expose GET /.well-known/oauth-protected-resource with canonical resource, authorization_servers, scopes_supported, and resource_documentation. Include the same metadata URL in WWW-Authenticate on 401.

- [ ] **Step 3: Implement middleware and production guards**

Verify JWT signature, issuer, audience, expiry, and ALLOWED_SUBJECT. In production, fail startup if OIDC_ISSUER, OIDC_AUDIENCE, ALLOWED_SUBJECT, TOKEN_ENCRYPTION_KEY, or HTTPS BASE_URL is absent.

- [ ] **Step 4: Verify local no-auth and production OAuth modes**

Run: npm test -- tests/auth tests/config.test.ts && npm run typecheck  
Expected: PASS, including proof that AUTH_MODE=none works only in development/test.

- [ ] **Step 5: Commit**

~~~bash
git add src/auth src/config.ts src/http/app.ts tests/auth tests/config.test.ts package.json package-lock.json
git commit -m "feat: protect hosted MCP with OAuth"
~~~

### Task 11: Docker deployment, end-to-end mock, and operator documentation

**Files:**
- Create: Dockerfile
- Create: .dockerignore
- Create: .env.example
- Create: README.md
- Create: tests/e2e/career-flow.test.ts
- Create: tests/e2e/fixtures.ts
- Modify: src/index.ts

**Interfaces:**
- Consumes all prior components.
- Produces a runnable container, documented ChatGPT setup, mocked end-to-end proof, and real-publish enablement checklist.

- [ ] **Step 1: Write the end-to-end test before deployment files**

The test boots the real Express/MCP stack with an in-memory database and mocked YC/company/LinkedIn endpoints, then performs:

1. search_yc_companies;
2. discover_public_people;
3. rank_networking_targets;
4. save_target and create_weekly_shortlist;
5. draft_linkedin_post and preview_post;
6. rejection while LINKEDIN_PUBLISH_ENABLED is false;
7. one enabled publish using the exact token;
8. replay rejection and one LinkedIn POST assertion.

- [ ] **Step 2: Run and fix integration seams only**

Run: npm test -- tests/e2e/career-flow.test.ts  
Expected: PASS without real network access or real credentials.

- [ ] **Step 3: Add container files**

Dockerfile uses a dependency/build stage and a non-root runtime stage, creates /app/data, exposes 3000, starts node dist/src/index.js, and defines a health check against /health. .dockerignore excludes .git, node_modules, coverage, data, .env files, and local SQLite files.

- [ ] **Step 4: Add environment template**

.env.example lists safe names and defaults only:

~~~dotenv
NODE_ENV=development
PORT=3000
DATABASE_PATH=./data/career-mcp.sqlite
BASE_URL=http://127.0.0.1:3000
AUTH_MODE=none
OIDC_ISSUER=
OIDC_AUDIENCE=
ALLOWED_SUBJECT=
TOKEN_ENCRYPTION_KEY=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=
LINKEDIN_VERSION=202606
LINKEDIN_PUBLISH_ENABLED=false
~~~

- [ ] **Step 5: Write README setup and safety runbook**

Document local install, migrations, tests, secure tunnel, ChatGPT Settings → Plugins → developer-mode app creation, OAuth provider requirements, LinkedIn app creation and w_member_social, redirect URI, kill switch, backup/restore, token rotation, ambiguous-publish handling, and the rule never to paste credentials into chat.

- [ ] **Step 6: Run full verification**

Run:

~~~bash
npm test
npm run typecheck
npm run build
npm run test:coverage
docker build -t career-mcp:local .
docker run --rm -d --name career-mcp-test -p 3000:3000 -e NODE_ENV=development -e AUTH_MODE=none career-mcp:local
curl --fail http://127.0.0.1:3000/health
docker stop career-mcp-test
~~~

Expected: tests PASS, typecheck/build exit 0, coverage report has no uncovered publishing-state branch, image builds, health returns {"status":"ok"}, and container stops cleanly.

- [ ] **Step 7: Confirm real publishing remains disabled**

Inspect .env.example, runtime defaults, Docker environment, and a live get_linkedin_connection_status call. Expected: configured may be false and publishingEnabled is false until the user supplies credentials privately and changes the kill switch.

- [ ] **Step 8: Commit**

~~~bash
git add Dockerfile .dockerignore .env.example README.md src/index.ts tests/e2e
git commit -m "feat: package and document hosted Career MCP"
~~~

### Task 12: Final review and ChatGPT tunnel handoff

**Files:**
- Modify only files required by verification findings.
- Update: README.md

**Interfaces:**
- Produces a clean main branch ready for user-supplied hosting and LinkedIn credentials.

- [ ] **Step 1: Run specification coverage audit**

Cross-check every acceptance criterion in docs/superpowers/specs/2026-07-16-career-mcp-design.md against a passing test or explicit manual checklist. Add a README acceptance table mapping criterion to evidence.

- [ ] **Step 2: Run clean-install verification**

Run from a clean checkout:

~~~bash
npm ci
npm test
npm run typecheck
npm run build
git status --short
~~~

Expected: all commands pass and git status is empty.

- [ ] **Step 3: Run the secure-tunnel smoke test**

Start the local server with mocked LinkedIn publishing, expose /mcp through OpenAI Secure MCP Tunnel or another HTTPS tunnel, create the developer-mode app in ChatGPT, scan tools, and verify a read-only search plus draft/preview flow. Do not enable real posting in this step.

- [ ] **Step 4: Review secrets and outbound domains**

Confirm source, test snapshots, logs, git history, Docker layers, and MCP outputs contain no secrets. Confirm outbound allow rules cover only configured public research hosts, OAuth issuer/JWKS, and api.linkedin.com.

- [ ] **Step 5: Final commit if documentation or fixes changed**

~~~bash
git add -A
git commit -m "chore: complete Career MCP verification"
~~~

If no files changed, do not create an empty commit.
