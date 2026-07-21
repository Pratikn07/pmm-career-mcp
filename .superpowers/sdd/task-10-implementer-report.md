# Task 10 implementer report

## Scope completed

- Added `LinkedInPublishingClient` with one-shot image initialization, exact-byte upload, and final post creation operations.
- Reloaded and decrypted the connected member credential independently for every initialize, upload, and final post operation.
- Initialized images through the exact versioned `POST /rest/images?action=initializeUpload` contract with the connected person URN as owner.
- Accepted only strict `urn:li:image:` identifiers and HTTPS upload URLs on normalized `linkedin.com` or `licdn.com` hosts and their subdomains. Unsafe URLs make no request.
- Uploaded the exact stored bytes once with the stored bearer credential and MIME type. No Images GET or internal retry exists.
- Extended the existing Posts adapter without changing `createTextPost` results. Zero media omits `content`, one image uses `content.media`, and two-to-four images use ordered `content.multiImage.images` with exact alt text.
- Classified only 400, 401, 403, and 422 as definite failures. Rate limits, 5xx, transport throws, malformed provider results, and successful final responses without a valid `x-restli-id` are terminal unknown results.
- Kept both publishing switches unchanged and false; made no live LinkedIn, Supabase, or Railway calls.

## TDD evidence

- Added transport tests before implementation.
- RED command:

  ```text
  npm test -- tests/linkedin/publishing-client.test.ts tests/linkedin/posts-client.test.ts
  ```

  It failed at compile time because `src/linkedin/publishing-client.ts` and `createPost` did not exist.
- The focused suite now proves exact initialize/upload/post requests, author ownership, version headers, no Images GET, hostname boundaries, exact bytes, image order and alt text, strict URNs, zero/one/two/four-media payloads, all required status classes, missing result handling, and no retry after ambiguity.

## Verification

Passed:

```text
npm test -- tests/linkedin/publishing-client.test.ts tests/linkedin/posts-client.test.ts  # 2 files, 54 tests
npm run typecheck
npm test                                                                             # 46 files, 849 tests
git diff --check
```

The build also passed as the test preflight. All HTTP interactions in these tests are local mocks; no live network service was contacted.

## Independent-review fixes

- Added fail-closed `redirect: "manual"` to image initialization, byte upload, and final post creation. Every 3xx remains an `unknown` result under the existing classifier and no `Location` target is followed.
- Added 307/308 regressions with an armed unapproved-host interceptor. The approved upload request completes once, while the redirect target receives neither the image bytes nor authorization because it is never contacted. Initialization and final-post tests likewise prove exactly one top-level dispatch and manual redirect handling.
- Replaced hole-skipping validation with an explicit own-index density check before credential loading. Sparse one-image and four-image arrays now fail with `VALIDATION_ERROR`, with zero credential lookups and zero network calls.
- Review-fix RED: the focused run had five intended failures—three missing manual redirect modes and two sparse-array bypasses.
- Review-fix GREEN: the focused suite passed 54/54 tests and typecheck/diff checks passed.

## Design notes

- `createLinkedInPostsClient.createPost` preserves the existing raw `{ status, postUrn? }` transport boundary, while `createLinkedInPublishingClient.createPost` maps it to the image workflow's `published | definite_failure | unknown` contract.
- Upload URL validation occurs both when parsing LinkedIn initialization output and immediately before byte upload.
- Provider bodies and thrown transport messages are never returned, logged, or persisted by this adapter.
