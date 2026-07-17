# Career MCP Design

Date: 2026-07-16  
Status: Approved for implementation  
Audience: One private user connecting from ChatGPT Developer Mode

## 1. Objective

Build a private, hosted MCP server that ChatGPT can use for two related workflows:

1. Research Y Combinator companies and publicly discoverable people, rank networking targets, draft outreach, and maintain a private pipeline.
2. Draft LinkedIn posts and publish an exact saved draft through LinkedIn's official API only after the user explicitly asks to publish it.

The product is a career and networking copilot, not a LinkedIn automation bot.

## 2. Confirmed requirements

- One user and one LinkedIn account.
- ChatGPT Developer Mode is the primary client.
- Production is a remotely hosted HTTPS MCP server.
- Local development uses a secure tunnel before deployment.
- Networking discovery is restricted to YC companies.
- All publicly discoverable roles may be considered: founders, executives, recruiters, marketers, engineers, and other employees.
- Coverage is best-effort and must never be described as a complete employee directory.
- Ranking combines Product Marketing opportunities, referral potential, and long-term networking value.
- Every recommendation includes source evidence and a last-checked timestamp.
- The system may draft and save outreach but never sends connection requests or LinkedIn messages.
- The system may draft and save posts but never publishes unless the user explicitly requests publishing in the current ChatGPT conversation.
- No autonomous or scheduled publishing.

## 3. Non-goals for version 1

- Scraping LinkedIn.
- Sending or accepting connection requests.
- Messaging LinkedIn members.
- Editing a LinkedIn profile.
- Enumerating every employee at every YC company.
- Reading private LinkedIn profile data.
- Posting comments, reactions, polls, videos, or documents.
- Image-post creation.
- Multi-user accounts, team roles, billing, or public distribution.
- Background cron jobs and unsolicited daily messages.
- A custom in-chat widget. Version 1 is tool-first and works through normal ChatGPT responses.

Text-only posts are the version-1 publishing format. Links may appear in the post text, but rich article previews and media uploads are deferred.

## 4. Platform constraints

ChatGPT Developer Mode connects to remote MCP servers over SSE or streaming HTTP and supports OAuth, no authentication, and mixed authentication. The production server will use streaming HTTP and OAuth; no-auth mode is permitted only for local development through a secure tunnel.

ChatGPT chooses tools from their names, descriptions, schemas, server instructions, and annotations. Therefore every tool must:

- represent one user intent;
- have explicit inputs and structured outputs;
- include read/write impact annotations;
- be safe to retry where possible;
- return citations and freshness information for research claims;
- avoid returning credentials or secrets.

LinkedIn posting uses the versioned Posts API at POST https://api.linkedin.com/rest/posts with w_member_social. The API version is configuration, not a hard-coded historical value.

## 5. High-level architecture

### 5.1 Runtime

- TypeScript on Node.js.
- Official @modelcontextprotocol/sdk.
- Streaming HTTP endpoint at /mcp.
- Lightweight HTTP framework for health, OAuth callbacks, and metadata endpoints.
- Zod schemas for all tool inputs and outputs.
- Docker image for deployment to any HTTPS container host with a persistent volume.

### 5.2 Modules

1. MCP transport
   - Initializes the server and instructions.
   - Registers tools and annotations.
   - Converts domain errors to safe MCP responses.

2. Research service
   - Imports YC company information from public YC pages.
   - Fetches allowed public company pages such as team, careers, blog, and press pages.
   - Optionally uses a configured search-provider adapter for wider public-web discovery.
   - Records evidence URL, page title, extraction time, and confidence.
   - Never fetches or automates linkedin.com pages.
   - Treats all fetched text as untrusted data, never as instructions.

3. Ranking service
   - Scores targets using configurable weights for PMM opportunity, referral potential, and broader networking value.
   - Returns component scores and human-readable reasons.
   - Treats missing or stale evidence as lower confidence rather than inventing facts.

4. Drafting service
   - Creates outreach drafts from verified target evidence and user preferences.
   - Creates versioned LinkedIn post drafts.
   - Does not require an external language-model API: ChatGPT may write the text and pass it to a save/revise tool.

5. Pipeline service
   - Saves targets, statuses, notes, outreach drafts, and shortlists.
   - Preserves history instead of overwriting prior drafts silently.

6. LinkedIn service
   - Manages LinkedIn OAuth.
   - Stores refresh/access tokens encrypted.
   - Publishes only the exact saved post version requested by the user.
   - Records every attempt and returned LinkedIn post identifier.

7. Persistence
   - SQLite on a persistent volume for the single-user deployment.
   - Drizzle-managed schema and migrations.
   - WAL mode and periodic backup instructions.

## 6. Research sources and coverage

### 6.1 Default sources

- YC public company directory and public YC company pages.
- Official company websites.
- Public team, leadership, careers, newsroom, blog, and press pages.
- Public job postings linked from official company pages.

### 6.2 Optional wider discovery

A SearchProvider interface allows a compliant web-search API to be configured later. The initial server must work without a search API key by using the default sources above. When no search provider is configured, results explicitly state that discovery is limited to authoritative pages.

The system stores only information necessary for networking decisions:

- name;
- publicly stated role;
- company;
- public source URL;
- optional public profile URL;
- evidence excerpt or normalized fact;
- discovery and last-checked timestamps.

It does not collect private contact data, infer sensitive attributes, or purchase third-party people datasets.

The public-page fetcher accepts only HTTP(S) URLs on public network addresses, revalidates redirects, blocks private and link-local destinations, enforces time and response-size limits, respects per-host rate limits, and accepts only expected text content types. Scripts, forms, hidden content, and active markup are discarded before extraction. These rules reduce SSRF, prompt-injection, and oversized-content risk.

## 7. MCP tool contract

### 7.1 Research tools

- search_yc_companies
  - Finds YC companies using batch, industry, status, location, keyword, or hiring filters.
  - Read-only.

- discover_public_people
  - Finds people associated with selected YC companies from allowed public sources.
  - Read-only from the user's perspective; internal cache refreshes are implementation details.

- find_pmm_opportunities
  - Finds PMM and adjacent opportunities plus hiring signals.
  - Read-only.

- rank_networking_targets
  - Ranks discovered people and returns component scores, evidence, confidence, and freshness.
  - Read-only.

- explain_target_match
  - Explains why one target is recommended and identifies missing evidence.
  - Read-only.

### 7.2 Drafting tools

- draft_outreach
  - Saves a personalized connection-note or follow-up draft.
  - Reversible write to private storage; no external action.

- draft_linkedin_post
  - Saves a new text post draft.
  - Reversible write to private storage; no external action.

- revise_post
  - Creates a new immutable version of an existing post draft.
  - Reversible write to private storage; no external action.

- preview_post
  - Returns the exact text, version, checksum, visibility, character count, and a one-use preview token that expires after 15 minutes.
  - Read-only.

- create_weekly_shortlist
  - Saves an on-demand shortlist. It does not schedule future work.
  - Reversible write to private storage.

### 7.3 Pipeline tools

- save_target
- update_outreach_status
- list_pipeline
- record_note
- list_post_history

All pipeline writes are bounded private writes with destructiveHint false.

### 7.4 LinkedIn connection tools

- get_linkedin_connection_status
  - Reports whether publishing credentials are configured and valid.
  - Never returns tokens.

- create_linkedin_authorization_url
  - Creates a short-lived, single-use state value and returns an authorization URL.
  - The callback stores tokens server-side.

### 7.5 Publishing tool

- publish_linkedin_post
  - The only tool that sends content to LinkedIn.
  - Inputs: draft ID, exact version, checksum, one-use preview token, visibility.
  - Requires LINKEDIN_PUBLISH_ENABLED=true.
  - Rejects missing, modified, or previously published draft versions and rejects expired or already-used preview tokens.
  - Tool description and server instructions state that it may be called only when the current user message explicitly asks to publish or post the displayed draft.
  - Marked readOnlyHint false, openWorldHint true, destructiveHint false.
  - ChatGPT confirmation remains enabled for the write action.
  - Never participates in a batch tool or background task.

## 8. Publishing safety state machine

Post states:

- draft
- ready_for_preview
- published
- publish_unknown
- publish_failed

Rules:

1. Creating or revising content increments the version and computes a SHA-256 checksum.
2. preview_post returns the immutable version, checksum, and a one-use preview token that expires after 15 minutes.
3. The user must explicitly request publishing after seeing the final content.
4. publish_linkedin_post reloads the saved version and verifies the checksum and preview token before any network call.
5. Successful creation records the LinkedIn post URN and marks the version published.
6. A definite API rejection records publish_failed and may be retried only after another explicit request.
7. A timeout or ambiguous network result records publish_unknown. The server never retries automatically because that could create a duplicate post.
8. Any edit creates a new version, so prior preview information no longer authorizes publishing.

The server cannot independently read the natural-language user message. It relies on accurate MCP tool metadata, server instructions, ChatGPT's write confirmation, the explicit publish-tool call, and exact draft-version validation. The product must not claim stronger proof of human intent than those controls provide.

## 9. Authentication and secrets

There are two separate OAuth relationships:

1. ChatGPT to the MCP server
   - Production uses OAuth 2.1 following the MCP authorization specification.
   - The MCP server publishes protected-resource metadata and validates audience-bound access tokens on every request.
   - A managed authorization server supplies login, token issuance, discovery metadata, PKCE support, and client registration.
   - Access is restricted to one configured subject or email.
   - Local tunnel development may use AUTH_MODE=none only when NODE_ENV is not production.

2. MCP server to LinkedIn
   - The server is the LinkedIn OAuth client.
   - Required permission for version 1 is w_member_social plus the minimum identity scopes needed to identify the authenticated author.
   - LinkedIn client secret and token-encryption key are host secrets.
   - LinkedIn tokens are encrypted at rest with authenticated encryption.
   - Tokens, authorization headers, state values, and secrets are redacted from logs and tool responses.

The user must eventually provide these values privately through local or host environment configuration, never in chat:

- LinkedIn Client ID.
- LinkedIn Client Secret.
- Production OAuth issuer/audience configuration for the MCP server.
- Token-encryption key.
- Public base URL and LinkedIn redirect URI.

## 10. Data model

- settings
  - career goals, ranking weights, preferred locations, role keywords.

- companies
  - YC identifier, name, batch, status, public URLs, metadata freshness.

- people
  - normalized name, role, company link, public profile URLs, last checked.

- evidence
  - source URL, title, fact type, normalized text, retrieved time, confidence.

- targets
  - person, ranking components, total score, status, rationale.

- outreach_drafts
  - target, purpose, text, version, timestamps.

- shortlists
  - named on-demand lists and ordered target entries.

- post_drafts
  - text, visibility, immutable version, checksum, state, timestamps.

- post_previews
  - draft version, hashed one-use token, expiry, consumed timestamp.

- publish_attempts
  - draft version, request time, response category, post URN, sanitized error.

- oauth_tokens
  - provider, encrypted token payload, expiry, refresh metadata.

Schema migrations are versioned and tested against a temporary database.

## 11. Error handling

- Validation errors return actionable messages without stack traces.
- Public URL validation rejects private networks, unsafe redirects, unsupported content types, and oversized responses.
- Fetched pages are treated as untrusted data; embedded instructions are never followed or elevated into server instructions.
- Source fetch failures are recorded per source; partial research results still return.
- Rate limits honor Retry-After where available and use bounded exponential backoff.
- Stale results show their age and never masquerade as fresh.
- OAuth expiration returns a reconnect instruction.
- Secrets and personal data are removed from structured logs.
- LinkedIn 4xx responses are not retried automatically.
- LinkedIn 429 and 5xx responses may be retried only before a request is known to have reached post creation; ambiguous create outcomes become publish_unknown.
- The health endpoint does not expose configuration values.

## 12. Testing strategy

### Unit tests

- Ranking component calculations and missing-evidence behavior.
- URL allow/deny rules, including an explicit linkedin.com fetch denial.
- SSRF protections, redirect revalidation, response limits, and untrusted-content sanitization.
- Draft versioning and checksum generation.
- Preview-token expiry, one-use consumption, and replay rejection.
- Publishing state transitions.
- Encryption round trips and log redaction.
- Tool annotation validation.

### Integration tests

- MCP initialization, tools/list, and representative tools/call requests.
- SQLite migrations and persistence.
- Mock YC/company pages and partial source failures.
- Mock OAuth metadata and token validation.
- Mock LinkedIn OAuth callback and Posts API responses.
- Duplicate-prevention behavior after timeouts.

### End-to-end tests

1. Start locally with real persistence and mocked external services.
2. Inspect the MCP using MCP Inspector.
3. Connect ChatGPT Developer Mode through a secure HTTPS tunnel.
4. Verify search, ranking, drafting, tracking, and preview flows.
5. Verify that publishing is disabled by default.
6. Verify rejection of changed drafts and verify that publishing has no automatic retry path.
7. Enable real LinkedIn OAuth only after all mock tests pass.
8. Perform one explicit, user-approved low-risk test post.

## 13. Deployment

- Multi-stage Docker build.
- One HTTPS container service.
- One persistent volume for SQLite and backups.
- Environment-based configuration validated at startup.
- /health endpoint for liveness.
- Graceful shutdown and database checkpoint.
- Production startup fails if authentication is disabled, encryption is missing, or default secrets are present.
- LINKEDIN_PUBLISH_ENABLED defaults to false.

The initial deployment provider is intentionally portable. Provider-specific files may be added after the user selects or supplies a hosting account.

## 14. Acceptance criteria

The version-1 implementation is complete when:

1. ChatGPT Developer Mode connects to the hosted streaming-HTTP MCP.
2. The MCP is authenticated in production and restricted to the one configured user.
3. YC company search returns source-backed results.
4. Public-person discovery never requests LinkedIn pages and clearly labels incomplete coverage.
5. Target ranking exposes component scores, evidence, confidence, and freshness.
6. Outreach and post drafts persist across chats.
7. Pipeline statuses, notes, and on-demand shortlists persist.
8. LinkedIn OAuth completes without exposing tokens.
9. Publishing is disabled by default.
10. Real publishing requires an explicit publish request, ChatGPT confirmation, an exact saved draft version/checksum, and a fresh one-use preview token.
11. Ambiguous publishing results are never retried automatically.
12. Automated tests and the mocked ChatGPT tunnel flow pass before the real LinkedIn credential is enabled.

## 15. Deferred enhancements

- Image and article post creation.
- Scheduled research refreshes and reminders.
- A visual pipeline widget inside ChatGPT.
- Resume ingestion and job-description comparison.
- Additional startup datasets beyond YC.
- Email or calendar integrations.
- Post analytics, which may require restricted LinkedIn read permissions.

## 16. References

- OpenAI ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
- OpenAI Apps SDK MCP server guide: https://developers.openai.com/apps-sdk/build/mcp-server
- OpenAI Apps SDK authentication: https://developers.openai.com/apps-sdk/build/auth
- MCP authorization specification: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- LinkedIn Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- LinkedIn User Agreement: https://www.linkedin.com/legal/user-agreement
