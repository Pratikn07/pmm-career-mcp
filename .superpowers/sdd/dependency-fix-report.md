# Production Dependency Advisory Remediation

Date: 2026-07-23

Base commit: `3d9fde411a918f82c5dd7ffc2041b3ad10e3bfa1`

## Root cause

`@modelcontextprotocol/sdk@1.29.0` declares `@hono/node-server@^1.19.9`, which resolved to
`1.19.14`. GitHub advisory `GHSA-frvp-7c67-39w9` marks every
`@hono/node-server` version below `2.0.5` as affected.

`@modelcontextprotocol/sdk@1.29.0` also declares `ajv@^8.17.1`. The installed
`ajv@8.20.0` resolved `fast-uri@3.1.3`, which is affected by
`GHSA-v2hh-gcrm-f6hx`.

The initial production audit reproduced three findings: one high and two moderate.
Trying the minimum Hono path-traversal fix (`2.0.5`) exposed another current
advisory, `GHSA-9mqv-5hh9-4cgg`, affecting Hono Node Server `2.0.0` through
`2.0.9`. Therefore `2.0.5` was not sufficient for a zero-finding production
audit.

## Reviewed remediation

- Keep the current, production-recommended MCP v1 SDK at `1.29.0`.
- Override only its transitive `@hono/node-server` package to exact version
  `2.0.11`.
- Override only AJV's transitive `fast-uri` package to exact version `3.1.4`.
- Add a lockfile regression test that preserves these reviewed versions and the
  Node 22 production-image constraint.

No forced audit fix, SDK downgrade, or application-code change was used.

## Compatibility review

- The official Hono Node Server v2 release says its public API stays the same.
  Its two documented breaking changes are dropping Node 18 and removing the
  Vercel adapter.
- The MCP SDK's installed Streamable HTTP adapter imports only
  `getRequestListener` from `@hono/node-server`.
- The published `getRequestListener` TypeScript signature is the same in
  `@hono/node-server@1.19.14` and `2.0.11`.
- This application builds and runs in `node:22-bookworm-slim` and does not import
  the removed Vercel adapter.
- `fast-uri@3.1.4` is the patched release on the same major line as the prior
  `3.1.3` resolution.

## Primary sources

- MCP SDK `1.29.0` registry metadata and dependencies:
  https://registry.npmjs.org/@modelcontextprotocol%2fsdk/1.29.0
- Hono Node Server `2.0.11` registry metadata:
  https://registry.npmjs.org/@hono%2fnode-server/2.0.11
- Hono Node Server v2 compatibility and breaking changes:
  https://github.com/honojs/node-server/releases/tag/v2.0.0
- Hono path-traversal advisory and patched range:
  https://github.com/advisories/GHSA-frvp-7c67-39w9
- Hono WebSocket-handshake DoS advisory and patched range:
  https://github.com/advisories/GHSA-9mqv-5hh9-4cgg
- Hono `2.0.10` security release:
  https://github.com/honojs/node-server/releases/tag/v2.0.10
- Hono `2.0.11` latest patch release:
  https://github.com/honojs/node-server/releases/tag/v2.0.11
- `fast-uri` authority-confusion advisory and patched ranges:
  https://github.com/advisories/GHSA-v2hh-gcrm-f6hx
- `fast-uri@3.1.4` registry metadata:
  https://registry.npmjs.org/fast-uri/3.1.4

## Test-first evidence

The new lockfile test was run before the overrides existed and failed because
`packageJson.overrides` was absent. After applying the exact overrides, the test
passed. It was then strengthened from Hono `2.0.5` to `2.0.11`, observed failing
against the intermediate `2.0.5` state, and passed again after the final update.

## Fresh verification

- `npm install`: updated only the two reviewed transitive packages.
- `npm audit --omit=dev`: `found 0 vulnerabilities`.
- Dependency tree:
  - `@modelcontextprotocol/sdk@1.29.0`
  - `@hono/node-server@2.0.11 overridden`
  - `ajv@8.20.0`
  - `fast-uri@3.1.4 overridden`
- Focused MCP, Streamable HTTP, auth, OAuth, review-card, and end-to-end suite:
  14 files, 82 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, including server, consent client, and review-card
  client builds.
- Full `npm test`: 58 files passed; 1,134 tests passed and 5 guarded local
  PostgreSQL tests skipped.
- Dockerfile/dependency static suite: 2 files, 8 tests passed.
- No live Supabase, Railway, ChatGPT, or LinkedIn operation was performed.
