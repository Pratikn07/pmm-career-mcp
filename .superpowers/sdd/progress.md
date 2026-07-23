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
| 3. Brand profile, hook, templates, and prompt | In progress | In progress | Pending | — |
| 4. Brand visual brief service | Pending | Pending | Pending | — |
| 5. Fonts and deterministic renderer | Pending | Pending | Pending | — |
| 6. Reusable private-media ingestion | Pending | Pending | Pending | — |
| 7. Persisted branded render and atomic attachment | Pending | Pending | Pending | — |
| 8. Brand Studio MCP tools | Pending | Pending | Pending | — |
| 9. Request wiring and review-card provenance | Pending | Pending | Pending | — |
| 10. Scheduled-flow safety and operator docs | Pending | Pending | Pending | — |
| 11. Full release verification | Pending | Pending | Pending | — |
| 12. Push, deploy, production smoke, and connector refresh | Pending | Pending | Pending | — |

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
