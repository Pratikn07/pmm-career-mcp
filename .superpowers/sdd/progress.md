# Subagent-Driven Development Progress

Plan: `docs/superpowers/plans/2026-07-17-supabase-deployment.md`
Branch: `codex/supabase-migration`
Worktree: `/Users/pratik.nandoskar/Documents/working/pmm-career-mcp/.worktrees/supabase-migration`

| Task | Status | Implementation | Review | Commit |
| --- | --- | --- | --- | --- |
| 1. Async application contract | Complete | Complete | Approved | `e71fc15`, `c065ef8`, `4c98988` |
| 2. PostgreSQL/PGlite migration | Complete | Complete | Approved | `60b51e1`, `3996537` |
| 3. Transaction/concurrency invariants | Complete | Complete | Approved | `16b6d97` |
| 4. Supabase OAuth resource protection | Complete | Complete | Approved | `7470828`, `c149cc3`, `2aa950b` |
| 5. Login and consent page | Complete | Complete | Approved | `4146c4e`, `6d3e77f` |
| 6. Readiness/startup/Docker | Complete | Complete | Approved | `01e51f0`, `6e468a1` |
| 7. Live smoke verification | Complete | Complete | Approved | `5b529b9`, `bfd0007`, `33b66f7` |
| 8. Operator documentation | Complete | Complete | Approved | `1dc8c02`, `d1ab36c` |
| 9. Final local release gate | Complete | Complete | Approved | No fixes required |
| 10. Cloud deployment and ChatGPT | In progress | — | — | — |

## Notes

- Publishing must remain disabled throughout implementation and deployment verification.
- No LinkedIn credentials or external posting are part of these tasks.
- Task 1 completed with 353/353 full-suite tests and passed typecheck; reviewer cleanup focused tests also passed.
- Task 2 completed with 368/368 tests, typecheck, build, no SQLite runtime dependencies, and explicit production TLS.
- Task 3 completed with 387/387 tests and independent approval of rollback, retry, locking, and exactly-once publish safeguards.
- Task 4 completed with 403/403 tests, build/typecheck, and independent approval of OAuth configuration, public-metadata, and secret-boundary hardening.
- Task 5 completed with 419 tests, a verified Docker image build, and independent approval of consent-page delivery/security controls.
- Task 6 completed with 427 tests, verified Docker readiness health checks, safe startup/shutdown behavior, and corrected Supabase operator guidance.
- Task 7 completed with 465 tests and independent approval of guarded Supabase smoke, token verification, and optional audience-hook tooling; no live database action occurred.
- Task 8 completed with 466 tests and independent approval of the local setup, environment split, and Supabase/Railway/ChatGPT operator runbook.
- Task 9 release gate passed: clean install, 466 tests, coverage, typecheck, build, Docker build, production audit (0 vulnerabilities), and fail-closed image check.

---

Plan: `docs/superpowers/plans/2026-07-19-linkedin-image-review-card.md`
Branch: `codex/supabase-migration`
Workspace: `/Users/pratik.nandoskar/Documents/Codex/2026-07-16/what/pmm-career-mcp`
Started: 2026-07-20

| Task | Status | Implementation | Review | Commit |
| --- | --- | --- | --- | --- |
| 1. Configuration and build dependencies | Complete | Complete | Approved | `9364dce` |
| 2. Request-scoped Supabase identity | Complete | Complete | Approved | `8b64b09` |
| 3. Media and publish-attempt persistence | Complete | Complete | Approved | `b077923` |
| 4. Storage RLS and user-JWT adapter | Complete | Complete | Approved | `c4a3018` |
| 5. Untrusted image ingestion | Complete | Complete | Approved; final minor closed | `616d7fb`, `ce610b3` |
| 6. Immutable media drafts and checksums | Complete | Complete | Approved | `13879e7` |
| 7. Draft tools and review-card resource | Complete | Complete | Approved | `0f14ac0` |
| 8. App-only exact previews | Complete | Complete | Approved | `6b9e2ff` |
| 9. Interactive review card | Complete | Complete | Approved | `5cf5230` |
| 10. LinkedIn image transport | Complete | Complete | Approved | `834b313` |
| 11. Durable app-only publishing | Complete | Complete | Approved | `33e3eaa` |
| 12. Schedule safety and release verification | Complete | Complete | Approved | `92e3dd0` |
| Final whole-branch review | Complete | Complete | Ready (0 findings) | `ce610b3` |

## LinkedIn image workflow constraints

- Keep `LINKEDIN_PUBLISH_ENABLED=false` and `LINKEDIN_IMAGE_PUBLISH_ENABLED=false` through all local and live verification.
- Create no live LinkedIn post during implementation.
- Scheduled runs may research and draft, but may never preview or publish.
- No service-role key, database password, LinkedIn credential, bearer token, or approval capability may be logged or exposed.
- Live Supabase/Railway changes wait at the explicit rollout checkpoint.

Task 1: complete (commits `acf01f3..9364dce`, review clean; controller verification: 95 focused tests plus typecheck passed).
Task 2: complete (commits `9364dce..8b64b09`, review clean; controller verification: 17 focused tests plus typecheck passed).
Task 3: complete (commits `8b64b09..b077923`, review clean; controller verification: 90 focused database tests plus typecheck passed).
Task 4: complete (commits `b077923..c4a3018`, review clean; controller verification: 16 focused Storage/auth tests plus typecheck passed).
Task 5: complete (commits `c4a3018..616d7fb`, review approved; controller verification: 52 focused media-security tests plus typecheck passed). The recorded default-HTTPS transport test gap was closed in `ce610b3` with an offline regression covering address pinning, Host/SNI, both lookup callback forms, `agent:false`, abort propagation, hostname mismatch, and fresh redirect requests.
Task 6: complete (commits `616d7fb..13879e7`, first review found two Important race/cleanup issues and two Minor contract/Unicode issues; all four were fixed and the re-review approved with no remaining findings; controller verification: 48 focused integration tests plus typecheck and diff check passed).
Task 7: complete (commits `13879e7..0f14ac0`, first review found one Important and one Minor annotation mismatch; both were fixed and the re-review approved with no remaining findings; controller verification: 23 focused tool/resource tests plus typecheck and diff check passed).
Task 8: complete (commits `0f14ac0..6b9e2ff`, first review found one Important snapshot-lock gap and one Minor concurrency-test gap; re-review then found one Minor cross-draft lock-order risk; all findings were fixed and final re-review approved with no remaining findings; controller verification: 96 focused database/preview/tool tests plus typecheck and diff check passed).
Task 9: complete (commits `6b9e2ff..5cf5230`, first review found two Important metadata/result-handling issues and one Minor signed-URL issue; re-review found one residual Important legacy-correlation issue and one Minor malformed-error issue; all findings were fixed and final re-review approved with no remaining findings; controller verification: 49 focused review-card/static/Docker tests plus typecheck, production build, and diff check passed).
Task 10: complete (commits `5cf5230..834b313`, first review found one Important redirect/one-shot issue and one Minor sparse-gallery issue; both were fixed and final re-review approved with no remaining findings; controller verification: 54 focused LinkedIn transport tests plus typecheck, production build, and diff check passed).
Task 11: complete (commits `834b313..33e3eaa`, first review found three Important safety issues: preview checksum binding, complete gallery-byte preflight, and credential validation before approval claim; all were fixed and final re-review approved with no remaining findings; controller verification: 121 focused publishing/database/MCP/e2e tests plus typecheck, build, and diff check passed; full implementer suite: 877 tests).
Task 12: complete (commits `33e3eaa..92e3dd0`, independent review approved with no findings; controller verification: 5 focused end-to-end tests plus production build passed; implementer verification: 881 tests, typecheck, build, production audit with 0 vulnerabilities, Docker build, and diff check passed; both publishing switches remained false and no live service was called).
Final whole-branch review: complete (range `acf01f3..ce610b3`). The first independent security/data and product/MCP reviews found four Important cross-task blockers plus smaller Unicode, expiry, no-auth, and transport-test gaps. Commit `ce610b3` fixed every finding: production signed launcher URLs, new-draft v2 checksums, exact whitespace rendering, versioned LinkedIn scope evidence before approval claim, Unicode alt-text boundaries, expiry revocation/guidance, complete local no-auth checks, default HTTPS pinning coverage, and a production `sharp` smoke. Both original reviewers re-reviewed the fix and returned READY with 0 Critical, 0 Important, and 0 Minor findings. Fresh controller verification: 905 tests, typecheck, production build, production audit with 0 vulnerabilities, Docker build with `sharp` import, diff check, and both publishing defaults false. No live service, deployment variable, approval, image upload, or LinkedIn post was created.

---

Plan: `docs/superpowers/plans/2026-07-22-pmm-brand-studio.md`
Branch: `codex/supabase-migration`
Workspace: `/Users/pratik.nandoskar/Documents/Codex/2026-07-16/what/pmm-career-mcp`
Started: 2026-07-22

| Task | Status | Implementation | Review | Commit |
| --- | --- | --- | --- | --- |
| 1. Brand Studio database schema | Complete | Complete | Approved | `a7a6f9f`, `ee8fad9` |
| 2. Brand Studio repositories | Complete | Complete | Approved | `e3fc681`, `636e414` |
| 3. Brand profile, hook, templates, and prompt | Complete | Complete | Approved | `8c0dfd4`, `9239603` |
| 4. Brand visual brief service | Complete | Complete | Approved | `0f142e6`, `8c01973` |
| 5. Fonts and deterministic renderer | Complete | Complete | Approved | `1a407c2`, `ca79fda`, `567a220` |
| 6. Reusable private-media ingestion | Complete | Complete | Approved | `1fae568`, `ee05259`, `ccc4dd9`, `572aa1e` |
| 7. Persisted branded render and atomic attachment | Complete | Complete | Approved | `cc6b0ea`, `1b06075`, `8e903a6`, `ecde433` |
| 8. Brand Studio MCP tools | Complete | Complete | Approved | `def0379` |
| 9. Request wiring and review-card provenance | Complete | Complete | Approved | `b0f545d` |
| 10. Scheduled-flow safety and operator docs | Complete | Complete | Approved | `8d4db4b`, `94371ac`, `3ab70e5`, `9006d4b`, `4e4c3cc` |
| 11. Full release verification | Complete | Complete | Approved | `ae6edf6` |
| 12. Push, deploy, production smoke, and connector refresh | In progress | In progress | Pending | — |

## PMM Brand Studio constraints

- Keep the approved identity: `PMM FIELD NOTES`, `BHAGYASHREE NANDOSKAR`, `PRODUCT MARKETING`, and `BN`.
- Covers create curiosity; they do not summarize or explain the whole LinkedIn post.
- Scheduled/model-visible tools may research, save briefs, render images, and attach private draft media only.
- Exact preview and publish remain app-only, checksum-bound, version-bound, and explicitly human-confirmed.
- Never expose database passwords, service-role keys, LinkedIn credentials, bearer tokens, or approval capabilities.
- Deploy only `codex/supabase-migration`; do not merge or deploy `main`.
- Do not initiate a paid Railway plan or billable upgrade.

Task 1: complete (commits `a7a6f9f`, `ee8fad9`). The three private, versioned Brand Studio tables, exact composite foreign keys, generated migration/snapshot, and reset coverage were independently approved. The first review found one Minor public-schema hardening gap; the follow-up commit closed it, and the re-review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 908 full-suite tests plus 51 focused repository tests passed; no live service was called.

Task 2: complete (commits `e3fc681`, `636e414`). Owner-scoped profile, brief, and render repositories were added with version-safe default creation, bounded recency, and exact joins. The first review found a Critical cross-owner post-reference gap and an Important rendered-media ownership gap; both were closed with non-leaking regression tests. Final re-review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 914 full-suite tests plus 57 focused repository tests passed; no live service was called.

Task 3: complete (commits `8c0dfd4`, `9239603`). The immutable PMM Field Notes profile, exact uppercase identity, five-color palette, two collision-free 1080×1350 templates, deterministic hook/topic rules, and private curiosity-first source-art prompt are implemented. The first review found exact-casing, palette, line-control, URL/bullet, and geometry issues; every finding was fixed with regression tests. Final re-review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 940 full-suite tests plus 26 focused brand-domain tests passed; no live service was called.

Task 4: complete (commits `0f142e6`, `8c01973`). The owner-scoped visual-brief service now binds to the exact latest post version, atomically initializes the canonical profile with the first brief, rejects recent hook reuse, returns model-safe provenance, and verifies media checksums. The first review found lock-order, transaction-atomicity, checksum-validation, and error-mapping issues; all were fixed and re-reviewed. Final review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 959 full-suite tests plus 76 focused service/repository tests passed; no live service was called.

Task 5: complete (commits `1a407c2`, `ca79fda`, `567a220`). Exact checksum-pinned Cormorant/Inter fonts and licenses, Resvg 2.6.2, deterministic SVG/Sharp rendering, safe asset resolution, source-raster bounds, text fitting, XML safety, and two-stage Docker packaging are implemented. Reviews found resource-bound, word-tier, topic-fit, mutable-input, cache, XML, Docker-assertion, and pre-copy memory issues; all were fixed. Final review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 988 full-suite tests plus 35 focused renderer/Docker tests passed; Docker daemon validation remains deferred to Task 11.

Task 6: complete (commits `1fae568`, `ee05259`, `ccc4dd9`, `572aa1e`). The existing hardened media path was extracted into one reusable private store with bounded immutable snapshots, inspected metadata, owner-scoped dedupe, ambiguous-write reconciliation, strict canonical row validation, and unforgeable same-store cleanup provenance. Multiple reviews found byte-bound, cleanup, race, reconciliation, pixel-accounting, and adapter-aliasing gaps; all were fixed. Final review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 1,049 full-suite tests plus 100 focused media/e2e tests passed; no live service was called.

Task 7: complete (commits `cc6b0ea`, `1b06075`, `8e903a6`, `ecde433`). The request-scoped render service now deterministically renders, privately stores, and atomically attaches one final branded cover to a new immutable post version while preserving exact profile/template/hook/checksum provenance and keeping source art unattached. Reviews found owner-isolation, lock-order, ambiguous-cleanup, mixed-isolation exclusivity, stale-version disclosure, and claim-ledger privilege gaps; every finding was fixed. PostgreSQL now arbitrates attachment-versus-brand-source use through a persistent claim row, and the runtime role can read but cannot directly mutate that ledger; only narrowly scoped trigger functions may maintain it. Final re-review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 1,099 full-suite tests plus 136 final focused tests passed, with four explicitly guarded loopback-only PostgreSQL tests deferred to Task 11; no live service was called.

Task 8: complete (commit `def0379`). Three authenticated model-visible tools now expose the active brand profile, save a private visual brief, and render/attach a private branded cover. Their strict schemas, read/write/open-world annotations, `sourceImage` file metadata, model-safe field projections, and curiosity-cover instructions preserve the scheduled-run boundary: exact preview and publish remain app-only, and no LinkedIn upload or publish capability is exposed. Independent review approved with 0 Critical and 0 Important findings; it recorded one non-blocking future-proofing suggestion to replace two nested whole-object spreads with explicit field projection. Verification: 1,102 full-suite tests plus 27 focused MCP tests passed; no live service was called.

Task 9: complete (commit `b0f545d`). Brand brief and render services are now composed lazily per authenticated request with one shared request-scoped private Storage adapter and the same owner subject. The non-writing review card can show an exact seven-field allowlist of position-zero brand provenance—series, profile/template versions, hook, abbreviated checksum, and validation—without source media, object paths, URLs, tokens, or Storage data. Exact preview, approval, and publish controls remain app-only and unchanged. Independent review returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 1,105 full-suite tests plus 83 focused composition/review-card tests and the review-card build passed; no live service was called.

Task 10: complete (commits `8d4db4b`, `94371ac`, `3ab70e5`, `9006d4b`, `4e4c3cc`). The authenticated end-to-end test proves the morning schedule can create a text draft, load PMM FIELD NOTES, save a statement brief, render one source-free 1080×1350 private PNG, and open the non-writing review card while creating zero previews, publish attempts, or LinkedIn calls; only the widget-only path can create an exact checksum-bound preview. The operator guide now includes the exact daily prompt, statement/metaphor sequences, and final-PNG-only/source-art-never-published rule. Review-driven hardening added authoritative immutable logical-draft ownership, owner-derived brief claims, fail-closed legacy backfill, runtime-role ledger restrictions, a fail-closed database-URL query allowlist, and a genuine loopback-only runtime-login verification harness with guaranteed credential restoration. Multiple re-reviews closed every ownership, startup-parameter, catalog/ACL, and teardown finding; final approval returned 0 Critical, 0 Important, and 0 Minor findings. Verification: 1,133 full-suite tests plus 289 final focused tests passed, with five explicitly guarded loopback-only PostgreSQL tests deferred to Task 11; no live service was called.

Task 11: complete at `ae6edf6`. The release gate restarted after an independently approved dependency remediation pinned `@hono/node-server@2.0.11` and `fast-uri@3.1.4` while preserving MCP SDK 1.29.0. Fresh verification passed current Supabase guidance review, diff/typecheck/build, 1,134 tests, coverage (85.98% statements, 83.13% branches, 90.89% functions, 86.79% lines), production audit with 0 vulnerabilities, production Docker build and four-font smoke, and all 10 guarded integration-file tests against a disposable loopback PostgreSQL 17 container. The five previously skipped real-PostgreSQL cases executed successfully, the container was removed, the worktree is clean, and the 40-commit GitHub deployment range is intentional. No live service was changed.
