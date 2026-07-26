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
| 12. Push, deploy, production smoke, and connector refresh | Complete | Complete | Production smoke passed | `b813cf0` |

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

Task 12: complete at deployed source commit `b813cf0`. The deployment branch was pushed to GitHub, Railway production deployment `9eb70d49-db9f-40c5-b3fa-60cee6b1381c` completed successfully, and both `/health` and `/ready` returned healthy responses. The personal ChatGPT connector was refreshed and exercised the three model-visible Brand Studio tools in a harmless production smoke. It created private draft `fbfd84cc-b0b1-4481-b612-0284711995b8` version 2 with `CONNECTIONS` visibility, attached one 1080×1350 PMM FIELD NOTES cover, displayed exact brand provenance, and stopped without an exact preview, LinkedIn upload, publication, or authorization URL. The requested cover sentence duplicated a complete sentence in the test post, so the approved `post_duplicate` guard correctly selected a distinct cover hook. Publishing remains app-only and explicitly human-confirmed.

---

Plan: `docs/superpowers/plans/2026-07-24-yc-founder-research-export.md`
Branch: `codex/founder-research-export`
Workspace: `/Users/pratik.nandoskar/Documents/Codex/2026-07-16/what/pmm-career-mcp-founder-research`
Started: 2026-07-24

| Task | Status | Implementation | Review | Commit |
| --- | --- | --- | --- | --- |
| 1. Secure JSZip production dependency | Complete | Complete | Approved | `943036f` |
| 2. Founder research/export schema | Complete | Complete | Approved | `eaefd5b`, `4ba5eca` |
| 3. Transactional repositories | Complete | Complete | Approved | `5c22d11`, `2f151ec` |
| 4. Founder roles and profile URLs | Complete | Complete | Approved | `a0417b1`, `33e4e49`, `4849e14`, `d4dbe94` |
| 5. Candidate confirmation service | Complete | Complete | Approved | `2205046`, `ba7a3be`, `981e627` |
| 6. Resumable research runs | Complete | Complete | Approved | `af77593`, `78fa177`, `c5b76eb`, `b8d891e` |
| 7. Outreach batches | Complete | Complete | Approved | `1d30a78`, `18be0ac`, `b209314`, `a06cb81`, `ad18f62`, `18e9315` |
| 8. Excel workbook builder | Complete | Complete | Approved | `2c20a0d`, `b8dbb36`, `0474f87` |
| 9. Export persistence and capabilities | Complete | Complete | Approved | `16737fe`, `6d43c2a` |
| 10. Download route | Complete | Complete | Approved | `1643008`, `8665ea8` |
| 11. Export card | Complete | Complete | Approved | `bb597f6`, `e2d7063`, `fb46b7c` |
| 12. MCP tools | Complete | Complete | Approved | `d32d144`, `85d6419`, `77dafae` |
| 13. Composition and E2E | Complete | Complete | Approved | `ee949cb`, `41f2f6f` |
| 14. Operator documentation | Complete | Complete | Approved | `491e7c5` |
| 15. Verification and rollout | Complete | Complete | Approved | `99dfc63`, `8582b06` |

## YC founder research constraints

- Server-side research may fetch YC and official company sources only; it never fetches LinkedIn.
- Public-search profile URLs remain candidates until official evidence or manual confirmation.
- The MCP never clicks Connect, sends an invitation/message, or automates LinkedIn.
- Runs are owner-scoped, resumable, limited to 50 companies, process five per call, and use two workers.
- Connection notes are evidence-backed, versioned, private, and at most 200 Unicode code points.
- Workbook artifacts stay in private Postgres, expire after seven days, and use repeatable 15-minute download capabilities.
- Raw credentials, tokens, workbook bytes, and capability URLs never enter model-visible results or logs.

Task 1: complete (commit `943036f`, independent review clean). ExcelJS 4.4.0 was rejected after its production-only audit reported 10 vulnerabilities (9 high, 1 moderate). Exact production `jszip@3.10.1` replaced it, the focused dependency tests passed 2/2, typecheck passed, and `npm audit --omit=dev` reported 0 vulnerabilities. Controller checks confirmed the feature branch and complete manifest/lockfile contain JSZip and no ExcelJS package entry.

Task 2: complete (commits `eaefd5b`, `4ba5eca`, independent re-review clean). Seven private owner-scoped research/export tables, append-only confirmation events, immutable run membership, bounded export/capability retention, guarded runtime-role privileges, and rejection-behavior tests are in place. Controller verification passed 158 focused database tests plus typecheck. Derived run counters are explicitly assigned to Task 3.

Task 3: complete (commits `5c22d11`, `2f151ec`, independent re-review clean). Owner-scoped transactional repositories now provide deterministic five-item leasing, expired-lease recovery, attempt-bound stale-worker rejection, per-item failure isolation, derived counters, founder/profile precedence, append-only decisions, exact workbook persistence, and reusable hashed download capabilities. Final independent verification passed 172 focused database tests, typecheck, and diff check.

Task 4: complete (commits `a0417b1`, `33e4e49`, `4849e14`, `d4dbe94`, independent final review clean). Pure founder-role and non-fetching LinkedIn profile URL validators now enforce trusted person/company evidence binding, conservative title semantics, safe Unicode and raw bounds, strict canonical `/in/` URLs, and semantic negation/relationship checks across punctuation. Final verification passed 138 focused tests, typecheck, and diff check; the modules contain no network operations.

Task 5: complete (commits `2205046`, `ba7a3be`, `981e627`, independent final review clean). The owner-scoped candidate service now validates fresh non-fetching public-search evidence, requires entity-safe founder/company binding in one actual result field, preserves candidates as non-canonical until official/manual resolution, supports idempotent explicit decisions with audit history, and derives canonical/ambiguity state from one owner-scoped snapshot. Final verification passed 297 focused tests, typecheck, and diff checks.

Task 6: complete (commits `981e627..b8d891e`, independent final review clean). The resumable owner-scoped coordinator now enforces 50-company runs, five-item calls, two workers, attempt-bound leases and atomic discovery persistence, 30-day fresh same-origin official evidence, deterministic public-search task rehydration, and safe partial failures. Final hardening prevents projection-time public search/off-origin fetches, centralizes conservative untrusted-instruction and entity-label validation, and keeps public-search candidate evidence owner-scoped rather than global. Independent verification passed 225 focused tests, typecheck, production build, and diff check.

Task 7: complete (commits `b8d891e..18e9315`, independent final review clean). The owner-scoped outreach service accepts only confirmed/verified founders, enforces NFC and 200 Unicode code points, uses exact evidence-backed claim templates, saves immutable `linkedin_connection_request` drafts, and exposes no LinkedIn action. Durable request IDs and full canonical payload hashes are protected by migrations, database constraints, and one serializable target/draft arbitration transaction, so identical retries reuse the original version and changed retries conflict without mutating the target. Final verification passed 260 focused tests, typecheck, production build, and diff check.

Task 8: complete (commits `18e9315..0474f87`, independent final review clean). The pure workbook builder emits a deterministic four-sheet OOXML package with inline strings, stable sorting, styles, freeze panes, filters, formula-injection neutralization, CRC32 reopening, fixed allowed ZIP parts, and no formulas, hyperlinks, macros, drawings, hidden content, or external relationships. Strict RFC3339, XML-scalar, candidate-URL, fixed safe-error projection, and 640 KiB high-entropy input-budget checks keep accepted 50-company workbooks below 5 MiB. Final verification passed 11 focused tests, typecheck, production build, production audit with 0 vulnerabilities, and diff check.

Task 9: complete (commits `0474f87..6d43c2a`, independent final review clean). Owner-scoped export creation persists exact XLSX bytes, SHA-256, MIME, filename, row counts, and seven-day expiry. A durable scoped idempotency-key hash plus a serializable create-or-reuse transaction handles concurrent retries, changed snapshots, different keys, and expired recreation. Repeatable 15-minute capabilities use random 256-bit raw tokens, store only SHA-256 hashes, validate with constant-time comparisons, and never expose raw tokens to model-visible results, logs, errors, or repository rows. Final verification passed 184 focused tests and the full suite, typecheck, production build, production audit with 0 vulnerabilities, and diff check.

Task 10: complete (commits `6d43c2a..8665ea8`, independent final review clean). A capability-protected route now serves exact persisted workbook bytes with checksum, length, attachment, no-store, nosniff, referrer, and restrictive CSP headers while collapsing missing, malformed, expired, and wrong capabilities to one non-revealing 404 response. The route runs before JSON parsing so malformed-body probes cannot escape that safe surface, and non-GET methods never load bytes. Final verification passed 43 focused HTTP/auth/MCP tests, typecheck, production build, and diff check. Application composition remains intentionally deferred to Task 13.

Task 11: complete (commits `8665ea8..fb46b7c`, independent final review clean). The private ChatGPT export card displays only a bounded run/workbook summary and one Download Excel button. It accepts the exact capability URL only through private tool-response metadata, binds it to both safe visible envelopes, rejects error results and substitutions, enforces exact canonical URL grammar, disables itself at expiry, and navigates only through ChatGPT's vetted `openExternal` bridge with redirects disabled. The canonical application origin is the sole widget domain/CSP redirect target, the bundled client is served no-cache/nosniff and packaged in Docker, and no LinkedIn or tool mutation exists. Final verification passed 33 focused card/HTTP/Docker tests, typecheck, production build, production audit with 0 vulnerabilities, and diff check.

Task 12: complete (commits `fb46b7c..85d6419`, independent final review approved). Six strict owner-derived private-write MCP tools now expose bounded YC founder research, public-search candidate ingestion, manual confirmation, outreach-draft saving, and private workbook export. Only official-source processing is open-world; no tool fetches LinkedIn, clicks Connect, sends an invitation/message, or publishes. Candidate batches return deterministic ordered per-item outcomes, outreach notes are NFC-normalized and capped at 200 code points, URL contracts are declaratively bounded, every model-visible summary is tested, and the export capability exists only in widget-private metadata bound to the exact safe card projection. The safe export metadata now truthfully includes run ID and creation time. Final verification passed 58 focused MCP/export/card tests, typecheck, production build, production audit with 0 vulnerabilities, and diff check.

Task 13: complete (commits `77dafae..41f2f6f`, independent final review clean). The application now composes authenticated owner-scoped founder run, candidate, outreach, and export services per MCP request while composing capability downloads once at application scope and preserving OAuth/body-parser order and the stateless MCP lifecycle. A two-company E2E proves official verification plus unresolved public search, candidate save/confirmation, two versioned connection notes, exact four-sheet workbook export, real card-controller metadata binding, `openExternal` capture, exact capability download, checksum/CRC reopening, and all summary counters. Cross-owner and unauthenticated access fail safely, while global network and tool-surface tripwires prove zero LinkedIn fetch, invitation, message, Connect, or publish operations. Final verification passed 35 focused tests, 266 relevant regressions, typecheck, production build, production audit with 0 vulnerabilities, and diff check.

Task 14: complete (commit `491e7c5`, independent review clean). The README and Supabase/Railway/ChatGPT runbook now document a copy-pasteable bounded daily workflow, repeated five-company processing, manual candidate confirmation/rejection, evidence-backed private outreach notes, workbook regeneration, 30-day evidence freshness, seven-day artifacts, and 15-minute capabilities. They explicitly require manual profile review and manual Connect while prohibiting LinkedIn scraping, browser automation, invitations, and messages. The deployment guide pins migration order, feature-branch-only Railway deployment, connector/card verification, cleanup, and rollback without secrets or paid upgrades. Documentation contract checks, typecheck, build, and diff checks passed.

Task 15: complete at deployed source commit `8582b06`. Supabase migrations `0007` through `0011` are applied, the private runtime role and Data API boundary passed live smoke verification, and Railway production deployment `9f96ae9d-220b-42f8-976c-0ab6e47cb0f0` is healthy on `codex/founder-research-export`. Two production-only export edge cases were found by the first 10-company pilot—unsafe company website values and workbook counters derived from rows instead of the persisted run—and were fixed with focused regression tests and independent review. The corrected 10-company and 50-company pilots both passed: unique bounded membership, five-company calls, two-worker concurrency, durable `NEEDS_PUBLIC_SEARCH` states, exact database/workbook counters, four-sheet CRC-valid workbooks, matching checksums, and zero LinkedIn requests, candidate decisions, outreach actions, invitations, messages, or publications. The approved text and image publishing switches remained enabled, but this founder workflow exposed no publish action. Final verification passed 1,490 tests with 5 guarded skips, coverage (86.61% statements, 82.44% branches, 92.44% functions, 87.45% lines), typecheck, all production builds, production audit with 0 vulnerabilities, Docker build plus JSZip/Sharp import smoke, diff check, and independent review with no findings. The live pilot intentionally did not claim founder coverage: all 50 companies remained queued for ChatGPT public-web candidate search and manual user review.
