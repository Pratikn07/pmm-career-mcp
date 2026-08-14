# LinkedIn Image Review Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private one-to-four-image LinkedIn drafts and a ChatGPT review card whose app-only exact-preview and publish actions require an explicit human confirmation.

**Architecture:** Model-visible MCP tools may ingest files, save immutable versions, and open the review card, but cannot create approval or publish. A request-scoped Supabase user JWT protects private Storage through RLS; app-only tools create a 15-minute one-use capability and execute the locked LinkedIn media/post sequence without automatic retry.

**Tech Stack:** Node.js 22, TypeScript 7, MCP SDK 1.29, OpenAI Apps SDK metadata, Express 5, Drizzle/PostgreSQL, Supabase Auth/Storage, `@supabase/supabase-js` 2.110.7, `sharp` 0.35.3, Vitest 4, PGlite, esbuild, Docker, Railway, LinkedIn versioned Images/MultiImage/Posts APIs.

## Global Constraints

- Work only on `codex/supabase-migration`; never deploy `main`.
- Keep `LINKEDIN_PUBLISH_ENABLED=false` and `LINKEDIN_IMAGE_PUBLISH_ENABLED=false` through build, migration, deployment, scheduled-flow testing, and exact-preview testing.
- Do not create a live LinkedIn post during implementation or automated verification.
- Scheduled runs may research, create/revise private drafts, attach images, and notify; they may never create exact previews, upload to LinkedIn, or publish.
- `create_exact_linkedin_preview` and `publish_exact_linkedin_post` must use `_meta.ui.visibility: ["app"]` and must not remain model-visible under legacy names.
- Store one to four JPG, PNG, or GIF images in a private Supabase bucket; enforce 20 MiB per image, fewer than 36,152,320 pixels, at most 250 GIF frames, and required alt text of 1–120 Unicode characters.
- Treat ChatGPT-generated images and user-uploaded images identically after they arrive through the Apps SDK file-parameter contract.
- Never configure, persist, print, or return a Supabase service-role/secret key, database password, LinkedIn credential, bearer token, or raw approval capability.
- Use Supabase Storage APIs, never direct writes to the `storage` schema; SQL may only define RLS policies on `storage.objects`.
- Keep database transactions short and make no Supabase or LinkedIn network request while holding a database transaction open.
- Preserve exact original image bytes; do not resize, recompress, strip metadata, or change formats in this version.
- Recompute SHA-256 for stored bytes before LinkedIn upload; any text, visibility, image bytes, order, MIME, or alt-text change requires a new immutable version and invalidates older previews.
- Final post creation is called at most once per consumed preview; ambiguous media or post results are terminal and are never retried automatically.
- Do not add an OpenAI API key, paid image service, Railway upgrade, or Supabase upgrade without separate approval.

## File Structure

New focused modules:

- `src/auth/request-context.ts` — request-scoped validated subject/token type and Express storage.
- `src/media/file-download.ts` — bounded HTTPS download with redirect, DNS, IP, timeout, and byte controls.
- `src/media/image-inspection.ts` — `sharp`-based type, dimension, pixel, and GIF-frame validation.
- `src/media/storage.ts` — private Supabase Storage adapter using publishable key plus user JWT.
- `src/media/post-media-service.ts` — ingest, dedupe, attach/reorder/remove, signed-preview URL, and cleanup orchestration.
- `src/posts/post-checksum.ts` — versioned, length-delimited whole-post checksum contract.
- `src/posts/review-service.ts` — app-only preview creation and widget-private capability result.
- `src/linkedin/publishing-client.ts` — LinkedIn initialize-upload, byte-upload, and one final Posts API request.
- `src/linkedin/image-publish-service.ts` — durable publish state machine and no-retry error classification.
- `src/review-card/controller.ts` — testable browser-independent review-card behavior.
- `src/review-card/client.ts` — `window.openai` adapter and DOM binding.
- `src/review-card/resource.ts` — `ui://` HTML resource plus minimal Apps SDK CSP metadata.
- `scripts/build-review-card.mjs` — deterministic esbuild bundle into `dist/public`.

Existing files remain responsible for their current domains and receive narrow extensions:

- `src/config.ts` — image switch and bucket configuration.
- `src/db/schema.ts`, `src/db/repositories.ts`, `drizzle/*` — normalized media and attempt state.
- `src/drafts/service.ts` — immutable versions containing ordered media.
- `src/posts/preview-service.ts` — legacy token code reused internally but never exposed to the model.
- `src/auth/resource-auth.ts`, `src/http/app.ts`, `src/index.ts` — propagate authenticated context to each stateless MCP server.
- `src/mcp/schemas.ts`, `src/mcp/server.ts` — draft tools, launcher, resource, and app-only tools.
- `src/linkedin/posts-client.ts`, `src/linkedin/publish-service.ts` — replaced by the new publishing interfaces without retaining a model-visible path.

## Shared Interfaces

Use these names consistently across tasks:

```ts
export type RequestAuthContext = Readonly<{
  subject: string;
  accessToken: string;
}>;

export type StoredPostMedia = Readonly<{
  id: string;
  ownerSubject: string;
  objectPath: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  originalFilename: string | null;
  createdAt: string;
}>;

export type OrderedPostMedia = Readonly<{
  position: number;
  mediaId: string;
  sha256: string;
  mimeType: StoredPostMedia["mimeType"];
  altText: string;
}>;

export type OpenAiFileRef = Readonly<{
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}>;

export type DraftMediaStorage = Readonly<{
  upload(path: string, bytes: Uint8Array, mimeType: StoredPostMedia["mimeType"]): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  remove(paths: readonly string[]): Promise<void>;
}>;

export type LinkedInPublishingClient = Readonly<{
  initializeImage(): Promise<
    | { outcome: "ready"; imageUrn: string; uploadUrl: string }
    | { outcome: "definite_failure" }
    | { outcome: "unknown" }
  >;
  uploadImage(input: { uploadUrl: string; bytes: Uint8Array; mimeType: StoredPostMedia["mimeType"] }): Promise<
    | { outcome: "uploaded" }
    | { outcome: "definite_failure" }
    | { outcome: "unknown" }
  >;
  createPost(input: {
    text: string;
    visibility: "PUBLIC" | "CONNECTIONS";
    media: readonly { imageUrn: string; altText: string }[];
  }): Promise<
    | { outcome: "published"; postUrn: string }
    | { outcome: "definite_failure" }
    | { outcome: "unknown" }
  >;
}>;
```

---

### Task 1: Lock configuration and build dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`
- Test: `tests/build/dockerfile.test.ts`

**Interfaces:**
- Produces: `AppConfig.linkedinImagePublishEnabled: boolean`
- Produces: `AppConfig.linkedinMediaBucket: "linkedin-draft-media"`
- Produces: installed runtime dependency `sharp@0.35.3`

- [ ] **Step 1: Write failing configuration tests**

Add cases that assert both switches default to false, the bucket defaults to the exact private name, invalid boolean values fail parsing, and production still rejects both `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_SECRET_KEY`:

```ts
const defaults = loadConfig({ NODE_ENV: "test" });
expect(defaults.linkedinPublishEnabled).toBe(false);
expect(defaults.linkedinImagePublishEnabled).toBe(false);
expect(defaults.linkedinMediaBucket).toBe("linkedin-draft-media");

expect(() => loadConfig({
  NODE_ENV: "test",
  LINKEDIN_IMAGE_PUBLISH_ENABLED: "yes"
})).toThrow();
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- tests/config.test.ts tests/build/dockerfile.test.ts`

Expected: FAIL because the image switch, media bucket, and `sharp` production dependency do not exist.

- [ ] **Step 3: Add exact configuration fields and dependency**

Add to the environment schema and `AppConfig`:

```ts
LINKEDIN_IMAGE_PUBLISH_ENABLED: z.enum(["true", "false"]).default("false"),
LINKEDIN_MEDIA_BUCKET: z.literal("linkedin-draft-media").default("linkedin-draft-media")
```

Map them as:

```ts
linkedinImagePublishEnabled: parsed.LINKEDIN_IMAGE_PUBLISH_ENABLED === "true",
linkedinMediaBucket: parsed.LINKEDIN_MEDIA_BUCKET
```

Install the pinned runtime package:

```bash
npm install --save-exact sharp@0.35.3
```

Document `LINKEDIN_IMAGE_PUBLISH_ENABLED=false` and `LINKEDIN_MEDIA_BUCKET=linkedin-draft-media` in `.env.example`. Do not add a secret-key variable.

- [ ] **Step 4: Run focused tests and build**

Run: `npm test -- tests/config.test.ts tests/build/dockerfile.test.ts && npm run typecheck`

Expected: PASS; Docker dependency checks recognize `sharp` as a production dependency and both switches remain false.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config.ts .env.example tests/config.test.ts tests/build/dockerfile.test.ts
git commit -m "chore: configure guarded LinkedIn image support"
```

### Task 2: Propagate request-scoped Supabase identity without persistence

**Files:**
- Create: `src/auth/request-context.ts`
- Modify: `src/auth/resource-auth.ts`
- Modify: `src/http/app.ts`
- Modify: `src/index.ts`
- Test: `tests/auth/resource-auth.test.ts`
- Test: `tests/http/mcp-lifecycle.test.ts`
- Test: `tests/mcp/http-safety.test.ts`

**Interfaces:**
- Produces: `RequestAuthContext`
- Changes: `mcpServerFactory: (context: RequestAuthContext | undefined) => McpServer`
- Guarantees: raw bearer tokens never enter logs, errors, database rows, or MCP structured output

- [ ] **Step 1: Write failing auth-context tests**

Assert that valid OAuth middleware stores an immutable context in `response.locals`, invalid tokens store nothing, and the stateless MCP factory receives the context for exactly that request:

```ts
expect(captured).toEqual({
  subject: "123e4567-e89b-12d3-a456-426614174000",
  accessToken: token
});
expect(Object.isFrozen(captured)).toBe(true);
```

Add a safety assertion that serialized HTTP/MCP responses do not contain the token.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- tests/auth/resource-auth.test.ts tests/http/mcp-lifecycle.test.ts tests/mcp/http-safety.test.ts`

Expected: FAIL because the middleware discards validated identity and the factory accepts no context.

- [ ] **Step 3: Add the request-context contract**

Create `src/auth/request-context.ts`:

```ts
export const REQUEST_AUTH_CONTEXT = Symbol("pmm-career-mcp.request-auth-context");

export type RequestAuthContext = Readonly<{
  subject: string;
  accessToken: string;
}>;

export type AuthenticatedLocals = {
  [REQUEST_AUTH_CONTEXT]?: RequestAuthContext;
};
```

After `jwtVerify` and all existing claim checks succeed, store:

```ts
response.locals[REQUEST_AUTH_CONTEXT] = Object.freeze({
  subject: payload.sub,
  accessToken: token
});
next();
```

Do not add logging around the context.

- [ ] **Step 4: Pass context into each stateless MCP server**

Change the handler signature to:

```ts
function streamableMcpHandler(
  factory: (context: RequestAuthContext | undefined) => McpServer
): RequestHandler
```

Read the symbol from `response.locals` immediately before creating the server. Preserve `undefined` only for non-production `AUTH_MODE=none` tests. Update `createCareerApplication` so every request creates its MCP server with that context.

- [ ] **Step 5: Run focused tests and full typecheck**

Run: `npm test -- tests/auth/resource-auth.test.ts tests/http/mcp-lifecycle.test.ts tests/mcp/http-safety.test.ts && npm run typecheck`

Expected: PASS with no bearer token in any response.

- [ ] **Step 6: Commit**

```bash
git add src/auth/request-context.ts src/auth/resource-auth.ts src/http/app.ts src/index.ts tests/auth/resource-auth.test.ts tests/http/mcp-lifecycle.test.ts tests/mcp/http-safety.test.ts
git commit -m "feat: propagate scoped Supabase request identity"
```

### Task 3: Add normalized media and publish-attempt persistence

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories.ts`
- Modify: `tests/support/database.ts`
- Create: `drizzle/0002_linkedin_media_review.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0002_snapshot.json`
- Test: `tests/db/repositories.test.ts`
- Test: `tests/db/schema-hardening.test.ts`
- Test: `tests/db/runtime-role.test.ts`

**Interfaces:**
- Produces: `database.postMedia`
- Produces: `database.postDraftMedia`
- Produces: `database.publishAttemptMedia`
- Extends: post states and durable publish phases

- [ ] **Step 1: Write failing repository and schema tests**

Cover owner-scoped SHA dedupe, four-position limit, alt-text limit, exact-version foreign keys, indexed foreign keys, immutable ordering, media-attempt rows, and new states. Required assertions include:

```ts
expect(await db.postMedia.getByOwnerAndSha(owner, sha)).toMatchObject({ ownerSubject: owner, sha256: sha });
expect(await db.postDraftMedia.listForVersion(versionId, 2)).toHaveLength(4);
await expectCheckViolation(insertWithPositionFour);
await expectCheckViolation(insertWith121CharacterAltText);
```

Extend `resetForTests()` so tables truncate in child-to-parent order: `publish_attempt_media`, `publish_attempts`, `post_previews`, `post_draft_media`, `post_media`, `post_drafts`.

- [ ] **Step 2: Run the database tests and confirm RED**

Run: `npm test -- tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts`

Expected: FAIL because the three media tables and repository methods do not exist.

- [ ] **Step 3: Add Drizzle tables and indexes**

Add these tables with lowercase names and explicit checks:

```ts
export const postMedia = careerMcp.table("post_media", {
  id: uuid("id").primaryKey(),
  ownerSubject: uuid("owner_subject").notNull(),
  objectPath: text("object_path").notNull(),
  sha256: text("sha256").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  frameCount: integer("frame_count").notNull().default(1),
  originalFilename: text("original_filename"),
  createdAt: timestamptz("created_at").notNull()
}, (table) => [
  uniqueIndex("post_media_owner_sha_unique").on(table.ownerSubject, table.sha256),
  uniqueIndex("post_media_object_path_unique").on(table.objectPath),
  check("post_media_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("post_media_mime_check", sql`${table.mimeType} in ('image/jpeg','image/png','image/gif')`),
  check("post_media_size_check", sql`${table.byteSize} between 1 and 20971520`),
  check("post_media_dimensions_check", sql`${table.width} > 0 and ${table.height} > 0 and (${table.width}::bigint * ${table.height}::bigint) < 36152320`),
  check("post_media_frames_check", sql`${table.frameCount} between 1 and 250`)
]);
```

Define `post_draft_media` with composite exact-version FK `(post_draft_id, version) -> post_drafts(id, version)`, FK `media_id -> post_media(id)`, primary key `(post_draft_id, version, position)`, unique `(post_draft_id, version, media_id)`, position `0..3`, alt text `char_length between 1 and 120`, and index `post_draft_media_media_id_idx(media_id)`.

Define `publish_attempt_media` with FK/index on `publish_attempt_id`, FK/index on `media_id`, unique `(publish_attempt_id, position)`, nullable LinkedIn image URN, and state check `pending|initialized|uploaded|definite_failure|unknown`.

Extend post states with `ready_for_review`, `previewed`, `uploading_media`, `media_upload_failed`, and `media_upload_unknown`. Extend attempt categories with `media_definite_rejection` and `media_ambiguous`; add attempt phase check `preflight|uploading_media|creating_post|complete` and `media_count between 0 and 4`.

- [ ] **Step 4: Generate and inspect the migration**

Run:

```bash
npx drizzle-kit generate --name linkedin_media_review
```

Run this from the checked-in migration state and require Drizzle to produce exactly `drizzle/0002_linkedin_media_review.sql` and `drizzle/meta/0002_snapshot.json`. If it chooses a different sequence, stop and inspect `drizzle/meta/_journal.json`; do not rename generated metadata by hand. The SQL must create the three application tables and indexes only; it must not insert/update/delete `storage.buckets` or `storage.objects`.

- [ ] **Step 5: Add repository methods with short transactions**

Implement:

```ts
postMedia.create(input): Promise<PostMedia>
postMedia.get(id: string): Promise<PostMedia | undefined>
postMedia.getByOwnerAndSha(ownerSubject: string, sha256: string): Promise<PostMedia | undefined>
postDraftMedia.listForVersion(postDraftId: string, version: number): Promise<PostDraftMediaWithMetadata[]>
postDrafts.createVersionWithMedia(input: PostDraftVersionInput & {
  ownerSubject: string;
  media: readonly { mediaId: string; altText: string }[];
}): Promise<{ post: PostDraft; media: PostDraftMediaWithMetadata[] }>
publishAttemptMedia.listForAttempt(attemptId: string): Promise<PublishAttemptMedia[]>
publishAttemptMedia.updateState(input): Promise<PublishAttemptMedia | undefined>
```

`createVersionWithMedia` locks the logical draft, validates every media row belongs to `ownerSubject`, sorts locks by media UUID, inserts the version and ordered join rows in one short serializable transaction, and makes no network call.

`post_drafts` remains the existing single-user table: its owner is the configured `ALLOWED_SUBJECT`. Every draft/media join must therefore be authorized against the current `RequestAuthContext.subject`, which resource authentication has already required to equal `ALLOWED_SUBJECT`.

- [ ] **Step 6: Run migration/repository tests**

Run: `npm test -- tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts`

Expected: PASS; the existing foreign-key-index audit reports no missing index.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/repositories.ts tests/support/database.ts drizzle/0002_linkedin_media_review.sql drizzle/meta/_journal.json drizzle/meta/0002_snapshot.json tests/db/repositories.test.ts tests/db/schema-hardening.test.ts tests/db/runtime-role.test.ts
git commit -m "feat: persist immutable LinkedIn draft media"
```

### Task 4: Define Supabase Storage RLS and user-JWT adapter

**Files:**
- Create: `supabase/migrations/20260719000000_linkedin_media_storage_rls.sql`
- Create: `src/media/storage.ts`
- Test: `tests/media/storage.test.ts`
- Test: `tests/auth/access-token-hook.test.ts`
- Modify: `docs/deployment/supabase-railway-chatgpt.md`

**Interfaces:**
- Produces: `createSupabaseDraftMediaStorage(config, auth): DraftMediaStorage`
- Requires: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `linkedin-draft-media`, request user JWT

- [ ] **Step 1: Write failing adapter and SQL policy tests**

Mock the Supabase client factory and prove every Storage request carries only the publishable key plus current bearer token. Assert the SQL contains the three owner-folder policies using cached `auth.uid()` and contains no bucket/object data mutation:

```ts
expect(clientFactory).toHaveBeenCalledWith(url, publishableKey, expect.objectContaining({
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
}));
expect(policySql).not.toMatch(/insert\s+into\s+storage\.(?:buckets|objects)/i);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/media/storage.test.ts tests/auth/access-token-hook.test.ts`

Expected: FAIL because no media Storage adapter or policies exist.

- [ ] **Step 3: Add exact Storage RLS policies**

The migration enables no new public table and creates three idempotent policies on `storage.objects`, each restricted to the exact bucket and first path segment:

```sql
do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media select own'
  ) then
    execute $ddl$
      create policy "linkedin draft media select own"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media insert own'
  ) then
    execute $ddl$
      create policy "linkedin draft media insert own"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media delete own'
  ) then
    execute $ddl$
      create policy "linkedin draft media delete own"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;
```

Uploads use `upsert: false`, so no UPDATE policy or privilege is granted. Do not create the bucket in SQL.

- [ ] **Step 4: Implement the user-JWT Storage adapter**

Use `createClient` with session persistence and refresh disabled. Every method selects `config.linkedinMediaBucket`; translate all Supabase error objects into generic `DomainError("MEDIA_STORAGE_ERROR", ...)` without retaining error bodies. Reject object paths whose first segment is not the exact authenticated subject before calling Supabase.

`createSignedUrl` accepts only `1..900` seconds and validates the returned URL uses the exact configured Supabase HTTPS origin.

- [ ] **Step 5: Document the manual private-bucket operation**

Add the exact dashboard settings:

```text
Bucket name: linkedin-draft-media
Public bucket: off
File size limit: 20 MiB
Allowed MIME types: image/jpeg, image/png, image/gif
```

State that this is a user/operator action because bucket creation is not authorized with the application user JWT. Document the custom-audience live gate: if Storage rejects the OAuth user token, stop and do not add a secret/service-role key.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/media/storage.test.ts tests/auth/access-token-hook.test.ts && npm run typecheck`

Expected: PASS; no service key exists anywhere in source or fixtures.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260719000000_linkedin_media_storage_rls.sql src/media/storage.ts tests/media/storage.test.ts tests/auth/access-token-hook.test.ts docs/deployment/supabase-railway-chatgpt.md
git commit -m "feat: protect draft images with Supabase RLS"
```

### Task 5: Ingest and inspect untrusted image files

**Files:**
- Create: `src/media/file-download.ts`
- Create: `src/media/image-inspection.ts`
- Test: `tests/media/file-download.test.ts`
- Test: `tests/media/image-inspection.test.ts`
- Modify: `src/domain/errors.ts`

**Interfaces:**
- Produces: `downloadOpenAiFile(file, deps): Promise<Uint8Array>`
- Produces: `inspectLinkedInImage(bytes, declaredMimeType?): Promise<ImageInspection>`
- Produces: safe errors `MEDIA_DOWNLOAD_ERROR`, `MEDIA_VALIDATION_ERROR`, `MEDIA_STORAGE_ERROR`, `AUTH_REQUIRED`

- [ ] **Step 1: Write failing download-policy tests**

Use an injected DNS resolver and hop transport to cover HTTPS success, HTTP rejection, credentials, loopback/private/link-local/reserved IPs, DNS rebinding, redirects to unsafe hosts, more than three redirects, timeout, empty body, and byte 20,971,521. Assert URLs and file IDs never appear in error messages.

```ts
await expect(downloadOpenAiFile(file, {
  resolveAddresses: async () => ["127.0.0.1"],
  requestHop
})).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_ERROR" });
```

- [ ] **Step 2: Write failing image-inspection tests**

Generate tiny JPG/PNG/GIF fixtures with `sharp`, then test declared MIME mismatch, malformed bytes, zero/oversized dimensions, 250-versus-251-frame GIF, and decoded-pixel limit. Assert returned metadata and SHA-256 describe the original bytes.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- tests/media/file-download.test.ts tests/media/image-inspection.test.ts`

Expected: FAIL because the downloader, inspector, and error codes do not exist.

- [ ] **Step 4: Implement a pinned-address HTTPS downloader**

Require `https:`. For every hop: resolve all addresses, call the existing public-IP policy, select one validated address, and use `https.request` with a custom `lookup` returning that exact address while preserving the original hostname as TLS `servername`. Allow redirect statuses 301/302/303/307/308 up to three; re-resolve and revalidate every new URL. Abort after 10 seconds and stop reading at 20 MiB.

Expose an injected `resolveAddresses` and `requestHop` seam so tests never use the public network.

- [ ] **Step 5: Implement strict `sharp` inspection**

Use:

```ts
const metadata = await sharp(bytes, {
  animated: true,
  failOn: "error",
  limitInputPixels: 36_152_319
}).metadata();
```

Map `jpeg|png|gif` to the exact MIME types, require width/height, check `width * height < 36_152_320`, require `1 <= pages <= 250`, compare the optional declared MIME, and compute SHA-256 over `bytes` without transformation.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- tests/media/file-download.test.ts tests/media/image-inspection.test.ts && npm run typecheck`

Expected: PASS, including the byte/pixel/frame boundaries.

- [ ] **Step 7: Commit**

```bash
git add src/media/file-download.ts src/media/image-inspection.ts src/domain/errors.ts tests/media/file-download.test.ts tests/media/image-inspection.test.ts
git commit -m "feat: validate untrusted LinkedIn draft images"
```

### Task 6: Build immutable media drafts and whole-post checksums

**Files:**
- Create: `src/posts/post-checksum.ts`
- Create: `src/media/post-media-service.ts`
- Modify: `src/drafts/service.ts`
- Modify: `src/db/repositories.ts`
- Test: `tests/posts/post-checksum.test.ts`
- Test: `tests/media/post-media-service.test.ts`
- Modify: `tests/drafts/service.test.ts`

**Interfaces:**
- Produces: `POST_CHECKSUM_CONTRACT = "pmm-career-mcp.linkedin-post.sha256.v2"`
- Produces: `checksumLinkedInPost(input): string`
- Produces: `createPostMediaService(...).attachFiles`, `.setMedia`, `.getVersion`
- Extends: `PostDraftVersion` with ordered `media`

- [ ] **Step 1: Write failing checksum tests**

Use this fixed vector and prove changes to contract, draft ID, version, UTF-8 byte length, text, visibility, count, position, SHA, MIME, or alt text change the checksum. Prove identical inputs are deterministic across object property order.

```ts
const vector = {
  draftId: "123e4567-e89b-12d3-a456-426614174000",
  version: 2,
  text: "Hello, PMM 👋",
  visibility: "CONNECTIONS" as const,
  media: [
    { position: 0, sha256: "a".repeat(64), mimeType: "image/png" as const, altText: "Chart" },
    { position: 1, sha256: "b".repeat(64), mimeType: "image/jpeg" as const, altText: "Team" }
  ]
};
expect(checksumLinkedInPost(vector)).toBe("56562ef828e0cebcbddd3199308862f08ed76afdf351476e41714ab6dba44261");
expect(checksumLinkedInPost({ ...vector, visibility: "PUBLIC" })).not.toBe(checksumLinkedInPost(vector));
```

The fixed value uses four-byte big-endian unsigned integers for version, media count, and position, and four-byte big-endian byte-length prefixes for every string field. Do not calculate the expected value by calling the function under test.

- [ ] **Step 2: Write failing media-service tests**

Cover attach 1–4 files, owner-scoped dedupe, replacement, removal, reorder, alt-text revision, stale expected version, wrong owner, failed validation, failed storage, database failure cleanup, and unchanged original bytes. Prove every mutation creates a new version and leaves the old ordered rows unchanged.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- tests/posts/post-checksum.test.ts tests/media/post-media-service.test.ts tests/drafts/service.test.ts`

Expected: FAIL because v2 checksums and media-aware drafts do not exist.

- [ ] **Step 4: Implement the canonical encoder**

Encode each field as `uint32be(byteLength) || UTF-8 bytes`, with a `uint32be` media count and position. Reject fields over `2^32-1` bytes and invalid 64-character lowercase media SHA. Hash the exact sequence with SHA-256. Do not JSON-stringify the checksum input.

- [ ] **Step 5: Implement media ingestion and version creation**

`attachFiles` performs download → inspect → owner/sha lookup → private Storage upload when new → media-row create → short `createVersionWithMedia` transaction. Object paths are:

```ts
`${subject}/${sha256.slice(0, 2)}/${mediaId}.${extension}`
```

The service normalizes alt text with NFC plus trim, rejects internal newlines and lengths outside 1–120 characters, preserves input order, and generates a v2 checksum inside the repository's version callback. Newly uploaded objects are removed best-effort if the database version write fails; cleanup errors are not substituted for the original safe error.

`setMedia` accepts only media IDs owned by the request subject and creates a new version with the requested order/alt text. `revisePost` copies the current ordered media and creates a v2 version. Legacy v1 text drafts remain readable but must be revised into v2 before exact review.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/posts/post-checksum.test.ts tests/media/post-media-service.test.ts tests/drafts/service.test.ts`

Expected: PASS with immutable old versions and deterministic checksums.

- [ ] **Step 7: Commit**

```bash
git add src/posts/post-checksum.ts src/media/post-media-service.ts src/drafts/service.ts src/db/repositories.ts tests/posts/post-checksum.test.ts tests/media/post-media-service.test.ts tests/drafts/service.test.ts
git commit -m "feat: version LinkedIn drafts with ordered media"
```

### Task 7: Register model-visible drafting tools and the review-card resource

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Create: `src/review-card/resource.ts`
- Test: `tests/mcp/annotations.test.ts`
- Test: `tests/mcp/tools.test.ts`
- Create: `tests/review-card/resource.test.ts`

**Interfaces:**
- Produces model-visible: `attach_linkedin_post_images`, `set_linkedin_post_images`, `open_linkedin_review_card`
- Produces resource: `ui://pmm-career-mcp/linkedin-review-card.html`
- Removes model visibility from: `preview_post`, `publish_linkedin_post`

- [ ] **Step 1: Write failing tool-list and resource tests**

Assert file input metadata and visibility exactly:

```ts
expect(attachTool._meta).toMatchObject({
  "openai/fileParams": ["images"]
});
expect(launcher._meta).toMatchObject({
  "openai/outputTemplate": "ui://pmm-career-mcp/linkedin-review-card.html",
  "openai/widgetAccessible": true
});
expect(modelVisibleNames).not.toContain("preview_post");
expect(modelVisibleNames).not.toContain("publish_linkedin_post");
```

Assert the resource MIME is `text/html+skybridge`, uses no third-party script/style URL, and CSP connect/resource domains contain only the canonical MCP origin and canonical Supabase origin.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/mcp/annotations.test.ts tests/mcp/tools.test.ts tests/review-card/resource.test.ts`

Expected: FAIL because legacy preview/publish are model-visible and no image tools/resource exist.

- [ ] **Step 3: Add strict Zod schemas**

Define:

```ts
export const openAiFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().max(100).optional(),
  file_name: z.string().max(255).optional()
}).strict();

export const attachLinkedInPostImagesInput = z.object({
  postId: id,
  expectedVersion: z.number().int().positive(),
  images: z.array(openAiFileSchema).min(1).max(4),
  altTexts: z.array(z.string().min(1).max(120)).min(1).max(4)
}).strict().refine((value) => value.images.length === value.altTexts.length);
```

`setLinkedInPostImagesInput` contains `postId`, `expectedVersion`, and zero-to-four `{ mediaId, altText }` items. `openLinkedInReviewCardInput` contains exact `postId` and `version`. Extend the connection-status output with `imagePublishingEnabled` so the user can verify both independent switches without exposing configuration values.

- [ ] **Step 4: Register only draft-capable model tools**

Update server instructions to say scheduled/model flows stop after private drafts and app-only preview/publish must never be described as model-callable. Require `RequestAuthContext` for media tools and return `AUTH_REQUIRED` without touching Storage when absent.

`open_linkedin_review_card` returns safe draft text/media metadata in `structuredContent`; signed media URLs, when needed for rendering, go only in result `_meta`. It does not write `post_previews` and its tests assert preview row count remains zero.

- [ ] **Step 5: Register the UI resource**

`registerResource` returns the fixed HTML shell with the canonical absolute `${baseUrl}/review-card-client.js`, semantic elements for full text, visibility, ordered images/alt text, version/checksum/expiry, validation errors, create-preview button, publish button, and a native confirmation dialog. Resource metadata contains the minimal Apps SDK CSP.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/mcp/annotations.test.ts tests/mcp/tools.test.ts tests/review-card/resource.test.ts && npm run typecheck`

Expected: PASS; launcher creates no preview and legacy model-visible publish names are absent.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/server.ts src/review-card/resource.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts tests/review-card/resource.test.ts
git commit -m "feat: expose private image drafting and review card"
```

### Task 8: Create app-only exact previews and hidden capabilities

**Files:**
- Create: `src/posts/review-service.ts`
- Modify: `src/posts/preview-service.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/posts/review-service.test.ts`
- Modify: `tests/posts/preview-service.test.ts`
- Modify: `tests/mcp/annotations.test.ts`
- Modify: `tests/mcp/tools.test.ts`

**Interfaces:**
- Produces app-only: `create_exact_linkedin_preview`
- Produces: `ReviewService.createExact(postId, version): Promise<{ preview: ExactPreview; approvalCapability: string; signedMediaUrls: readonly { position: number; url: string }[] }>`
- Guarantees: capability appears only in MCP result `_meta.approvalCapability`

- [ ] **Step 1: Write failing review-service tests**

Cover v2 checksum verification, latest-version requirement, owner match, zero-to-four media, signed URLs with 900-second maximum, legacy-v1 rejection, stale revision, expiry, random source validation, and absent token leakage.

- [ ] **Step 2: Write failing app-only metadata tests**

Assert:

```ts
const approvalCapability = "a".repeat(43);
const signedMediaUrls = [{ position: 0, url: "https://project.supabase.co/storage/v1/object/sign/linkedin-draft-media/image" }];
expect(exactPreviewTool.annotations).toEqual({
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false
});
expect(exactPreviewTool._meta).toMatchObject({ ui: { visibility: ["app"] } });
expect(exactPreviewTool._meta).toMatchObject({ "openai/widgetAccessible": true });
expect(result.structuredContent).not.toHaveProperty("approvalCapability");
expect(result._meta).toEqual({ approvalCapability, signedMediaUrls });
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- tests/posts/review-service.test.ts tests/posts/preview-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts`

Expected: FAIL because no app-only exact-preview action with widget-private metadata exists.

- [ ] **Step 4: Implement exact review creation**

Reload the latest draft/media under the request subject, recompute v2 checksum, create a 32-byte base64url capability, store only the context-separated SHA-256 hash, and create signed URLs for each object. Return text, visibility, ordered media metadata, alt text, version, checksum, and expiry in `structuredContent`; return only the capability and signed URLs in widget-private `_meta`. Atomically insert the preview and move `draft` or `ready_for_review` to `previewed`; an already-`previewed` latest version remains `previewed` while receiving the replacement preview. If signed-URL creation fails, persist no preview.

- [ ] **Step 5: Register the app-only tool**

The input is `{ postId, version }`. Return full exact non-URL preview data in `structuredContent`, a short non-secret text summary, and only `{ approvalCapability, signedMediaUrls }` in `_meta`. Do not reuse the generic `response()` helper because that helper cannot enforce widget-private metadata.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/posts/review-service.test.ts tests/posts/preview-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts && npm run typecheck`

Expected: PASS; the model-visible namespace contains no exact-preview action.

- [ ] **Step 7: Commit**

```bash
git add src/posts/review-service.ts src/posts/preview-service.ts src/mcp/schemas.ts src/mcp/server.ts tests/posts/review-service.test.ts tests/posts/preview-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts
git commit -m "feat: create widget-private exact LinkedIn previews"
```

### Task 9: Build the interactive review card

**Files:**
- Create: `src/review-card/controller.ts`
- Create: `src/review-card/client.ts`
- Create: `scripts/build-review-card.mjs`
- Modify: `package.json`
- Modify: `src/review-card/resource.ts`
- Modify: `src/http/app.ts`
- Modify: `Dockerfile`
- Test: `tests/review-card/controller.test.ts`
- Modify: `tests/review-card/resource.test.ts`
- Create: `tests/http/review-card-client.test.ts`
- Modify: `tests/build/dockerfile.test.ts`

**Interfaces:**
- Produces: `createReviewCardController(deps)`
- Produces bundle: `dist/public/review-card-client.js`
- Consumes: `window.openai.callTool`, `window.openai.toolOutput`, `window.openai.toolResponseMetadata`

- [ ] **Step 1: Write failing controller tests**

With fake UI and `callTool`, prove initial render cannot publish, create-preview is a distinct user event, publish remains disabled without widget-private capability, confirmation cancellation makes no call, confirmation acceptance calls exactly once, busy state suppresses double-clicks, and all errors are generic.

```ts
await controller.publish();
expect(callTool).not.toHaveBeenCalled();

await controller.createPreview();
expect(callTool).toHaveBeenCalledWith("create_exact_linkedin_preview", { postId, version });
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/review-card/controller.test.ts tests/review-card/resource.test.ts tests/http/review-card-client.test.ts tests/build/dockerfile.test.ts`

Expected: FAIL because no controller or client bundle exists.

- [ ] **Step 3: Implement the pure controller**

Keep approval capability only in a closure. After `create_exact_linkedin_preview` resolves, obtain capability through an injected `getToolResponseMetadata()` and verify it matches `/^[A-Za-z0-9_-]{43}$/`. Render exact preview fields from structured output. `publish()` requires capability plus `confirm({ version, mediaCount, visibility })`, clears capability before invoking the publish tool, and never retries.

- [ ] **Step 4: Bind controller to `window.openai` and safe DOM operations**

Use only `textContent`, explicit attributes, and `replaceChildren`; never assign user content to `innerHTML`. Image elements use widget-private signed URLs, escaped alt attributes via property assignment, `referrerPolicy="no-referrer"`, and fixed order. The publish button label is exactly “Publish this exact version to LinkedIn”. The HTML resource references the absolute `${baseUrl}/review-card-client.js`; do not rely on iframe-relative URL resolution.

- [ ] **Step 5: Add deterministic build and Docker packaging**

Create `scripts/build-review-card.mjs` mirroring the consent build with IIFE, ES2022, minification, no source map, and output `dist/public/review-card-client.js`. Change:

```json
"build": "npm run build:server && npm run build:consent && npm run build:review-card",
"build:review-card": "node scripts/build-review-card.mjs"
```

Serve `/review-card-client.js` from `dist/public` with `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, and no access to configuration or secrets. Ensure Docker's existing `COPY scripts` and `COPY src` produce the bundle; add a Docker test that checks the build stage contains it.

- [ ] **Step 6: Run focused tests and production build**

Run: `npm test -- tests/review-card/controller.test.ts tests/review-card/resource.test.ts tests/http/review-card-client.test.ts tests/build/dockerfile.test.ts && npm run build`

Expected: PASS and `dist/public/review-card-client.js` exists.

- [ ] **Step 7: Commit**

```bash
git add src/review-card/controller.ts src/review-card/client.ts src/review-card/resource.ts src/http/app.ts scripts/build-review-card.mjs package.json Dockerfile tests/review-card/controller.test.ts tests/review-card/resource.test.ts tests/http/review-card-client.test.ts tests/build/dockerfile.test.ts
git commit -m "feat: add human-operated LinkedIn review card"
```

### Task 10: Implement one-shot LinkedIn image and multi-image transport

**Files:**
- Create: `src/linkedin/publishing-client.ts`
- Modify: `src/linkedin/posts-client.ts`
- Create: `tests/linkedin/publishing-client.test.ts`
- Modify: `tests/linkedin/posts-client.test.ts`

**Interfaces:**
- Produces: `LinkedInPublishingClient`
- Preserves: one final `POST /rest/posts` request and generic transport results

- [ ] **Step 1: Write failing LinkedIn transport tests**

Mock exact requests for image initialization, upload, single-image `content.media`, and multi-image `content.multiImage.images`. Verify author ownership, alt text/order, version headers, allowed upload hostnames, no GET Images call under write-only scope, and one final post request.

Cover 400/401/403/422 definite failures, 429/5xx/transport throws as unknown, missing/malformed URNs, unsafe upload URLs, and no internal retry.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/linkedin/publishing-client.test.ts tests/linkedin/posts-client.test.ts`

Expected: FAIL because only text posts exist.

- [ ] **Step 3: Implement initialize and upload calls**

Initialize with exactly:

```http
POST https://api.linkedin.com/rest/images?action=initializeUpload
Linkedin-Version: 202606
X-Restli-Protocol-Version: 2.0.0
Authorization: Bearer linkedin-test-access-token

{"initializeUploadRequest":{"owner":"urn:li:person:person-123"}}
```

The header and owner above are test fixtures; production uses `AppConfig.linkedinVersion` and reloads the encrypted connected-member credential. Accept only image URNs matching `^urn:li:image:[A-Za-z0-9_-]+$` and HTTPS upload URLs whose normalized hostname is `linkedin.com`, a subdomain of `linkedin.com`, `licdn.com`, or a subdomain of `licdn.com`. Upload the exact bytes once with the returned URL and stored bearer token. Do not issue a GET because `w_member_social` is write-only for the versioned Images API.

- [ ] **Step 4: Implement exact single/multi post payloads**

Zero media omits `content`; one media uses:

```ts
content: { media: { id: imageUrn, altText } }
```

Two-to-four media uses:

```ts
content: { multiImage: { images: media.map(({ imageUrn, altText }) => ({ id: imageUrn, altText })) } }
```

Classify any successful status without a valid `x-restli-id` as unknown. Make no retry in any method.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/linkedin/publishing-client.test.ts tests/linkedin/posts-client.test.ts && npm run typecheck`

Expected: PASS with exact request counts.

- [ ] **Step 6: Commit**

```bash
git add src/linkedin/publishing-client.ts src/linkedin/posts-client.ts tests/linkedin/publishing-client.test.ts tests/linkedin/posts-client.test.ts
git commit -m "feat: add one-shot LinkedIn image publishing transport"
```

### Task 11: Enforce durable image publishing and app-only publish action

**Files:**
- Create: `src/linkedin/image-publish-service.ts`
- Modify: `src/linkedin/publish-service.ts`
- Modify: `src/posts/preview-service.ts`
- Modify: `src/db/repositories.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Create: `tests/linkedin/image-publish-service.test.ts`
- Modify: `tests/linkedin/publish-service.test.ts`
- Modify: `tests/mcp/annotations.test.ts`
- Modify: `tests/mcp/tools.test.ts`

**Interfaces:**
- Produces app-only: `publish_exact_linkedin_post({ approvalCapability })`
- Consumes: `ReviewService`, `DraftMediaStorage`, `LinkedInPublishingClient`
- Produces terminal states: `published|media_upload_failed|media_upload_unknown|publish_failed|publish_unknown`

- [ ] **Step 1: Write failing state-machine tests**

Cover disabled master switch, disabled image switch, expired/replayed/stale/wrong-owner/wrong-checksum capabilities, zero/one/four media success, five-media corruption, stored-byte checksum mismatch, first/second image definite failure, ambiguous upload, final definite failure, final ambiguity, database completion failure, and two concurrent publish calls.

Every case asserts exact external call counts. Critical assertions:

```ts
expect(client.createPost).toHaveBeenCalledTimes(expectedFinalPostCalls);
expect(client.initializeImage).toHaveBeenCalledTimes(expectedInitializations);
expect(storage.download).toHaveBeenCalledTimes(expectedDownloads);
```

- [ ] **Step 2: Write failing app-only action tests**

Assert input is only `{ approvalCapability }`, metadata contains `_meta.ui.visibility: ["app"]` and `_meta["openai/widgetAccessible"]: true`, annotations are external write, no raw capability appears in output, and legacy `publish_linkedin_post` is absent from model-visible tools.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- tests/linkedin/image-publish-service.test.ts tests/linkedin/publish-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts`

Expected: FAIL because the current service accepts model-supplied metadata and only calls `createTextPost`.

- [ ] **Step 4: Implement atomic claim and short state updates**

In one short serializable transaction, hash/reload the capability, validate owner/version/checksum/expiry/unused state, consume it, create the attempt plus ordered attempt-media rows, and transition to `uploading_media` when media exist or `publishing` for text-only. Release the transaction before Storage or LinkedIn calls.

For every media item: download private bytes, recompute SHA-256, initialize once, upload once, and update its attempt row. Definite media failure transitions to `media_upload_failed`; ambiguous initialization/upload transitions to `media_upload_unknown`. Both stop before `createPost`.

After all definite upload successes, transition to `publishing`, call `createPost` exactly once, then use a short conditional update to record the terminal result. Any uncertainty after post dispatch returns `publish_unknown` and never retries.

- [ ] **Step 5: Register only the app-only publish action**

Use strict schema:

```ts
z.object({
  approvalCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict()
```

Set `_meta.ui.visibility: ["app"]`, `readOnlyHint: false`, `openWorldHint: true`, and `destructiveHint: false`. The handler uses request context from server options and returns only terminal state/post URN when definite.

- [ ] **Step 6: Run focused and end-to-end safety tests**

Run: `npm test -- tests/linkedin/image-publish-service.test.ts tests/linkedin/publish-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts tests/e2e/career-flow.test.ts`

Expected: PASS; no test makes a real LinkedIn request.

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/image-publish-service.ts src/linkedin/publish-service.ts src/posts/preview-service.ts src/db/repositories.ts src/mcp/schemas.ts src/mcp/server.ts src/index.ts tests/linkedin/image-publish-service.test.ts tests/linkedin/publish-service.test.ts tests/mcp/annotations.test.ts tests/mcp/tools.test.ts tests/e2e/career-flow.test.ts
git commit -m "feat: require app-only approval for LinkedIn publishing"
```

### Task 12: Integrate scheduled-flow safety, documentation, and rollout verification

**Files:**
- Modify: `tests/e2e/career-flow.test.ts`
- Create: `tests/e2e/linkedin-image-flow.test.ts`
- Modify: `README.md`
- Modify: `docs/deployment/supabase-railway-chatgpt.md`
- Modify: `.env.example`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: verified schedule contract and operator checklist
- Produces: production deployment procedure with both switches off until final approval

- [ ] **Step 1: Write failing end-to-end boundary tests**

Create an in-memory MCP client with fake download/Storage/LinkedIn adapters. Test:

```text
research -> draft -> attach image -> open review card -> stop
```

Assert zero preview rows, zero LinkedIn initialization calls, zero uploads, and zero final post calls. Separately test app-only preview through the review service and disabled-switch publish rejection before any external call.

- [ ] **Step 2: Run E2E tests and confirm RED**

Run: `npm test -- tests/e2e/career-flow.test.ts tests/e2e/linkedin-image-flow.test.ts`

Expected: FAIL until the complete dependency composition and schedule boundary are wired.

- [ ] **Step 3: Finish production composition and unavailable adapters**

In `createCareerApplication`, construct request-scoped Storage/media/review/publish dependencies only when auth context, Supabase URL, and publishable key exist. In local `AUTH_MODE=none`, text/research tools continue to work; media/review actions return `AUTH_REQUIRED` without network calls. Unavailable LinkedIn adapters return generic OAuth errors.

- [ ] **Step 4: Update user and operator documentation**

Replace “text-only” language. Include the exact morning schedule instruction from the approved design, both switch meanings, private bucket settings, model-visible versus app-only tools, legacy-draft revision requirement, no-retry states, and the manual `publish_unknown` check.

Add the scheduled image capability gate: if ChatGPT cannot hand a generated image file to a scheduled MCP call, save the text draft plus image brief and finish; do not add an API key.

- [ ] **Step 5: Run all local verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
docker build -t pmm-career-mcp:image-review .
```

Expected: all tests pass, typecheck/build pass, production audit reports zero vulnerabilities, and Docker build succeeds with the native `sharp` runtime.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/career-flow.test.ts tests/e2e/linkedin-image-flow.test.ts README.md docs/deployment/supabase-railway-chatgpt.md .env.example src/index.ts
git commit -m "feat: integrate guarded LinkedIn image workflow"
```

## Live rollout checkpoint

Execution pauses after Task 12 and reports local evidence before changing Supabase or Railway. With the user's approval, perform these operator steps in order:

1. Create the private `linkedin-draft-media` bucket with the exact settings in Task 4; no paid plan change.
2. Apply the Supabase RLS migration and Drizzle migration using the existing owner connection without printing its password.
3. Keep both Railway switches false and deploy only `codex/supabase-migration`.
4. Use the authenticated ChatGPT connector to attach a harmless test image to a private draft; this is the custom-audience Storage JWT gate.
5. If Storage rejects the token, stop. Do not add a service-role/secret key.
6. Refresh PMM Career MCP in ChatGPT and verify the app-only action metadata and review card.
7. Run the morning schedule smoke with a private draft and confirm there are no preview rows and no LinkedIn calls.
8. Create an exact interactive preview with both publish switches false and confirm publishing is blocked before LinkedIn.
9. Report results and request explicit approval before setting `LINKEDIN_PUBLISH_ENABLED=true` and `LINKEDIN_IMAGE_PUBLISH_ENABLED=true`.
10. Enabling the switches does not authorize a post. Any first live post still requires a separate exact preview, the user's final card confirmation, and one deliberate publish attempt.

## Final verification commands

```bash
git status --short --branch
git diff --check
npm test
npm run typecheck
npm run build
npm audit --omit=dev
docker build -t pmm-career-mcp:image-review .
git log --oneline --decorate -15
```

Expected final state before live rollout:

```text
branch: codex/supabase-migration
working tree: clean
tests: all passed
typecheck: passed
build: passed
production vulnerabilities: 0
Docker build: passed
LinkedIn publishing switches: false / false
live LinkedIn posts created by this work: 0
```
