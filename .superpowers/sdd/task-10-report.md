# Task 10 report: capability-protected founder export download

## Outcome

Added an optional, narrow `downloadFounderExport(exportId, capability)`
dependency to `createHttpApp` and registered the private workbook route before
the generic MCP handler.

The route:

- serves the verifier's exact buffer only for `GET`;
- sets the persisted XLSX MIME type, attachment filename, byte length, strong
  checksum ETag, `private, no-store`, `Pragma: no-cache`, `nosniff`,
  `Referrer-Policy: no-referrer`, and a deny-by-default CSP;
- returns one generic 404 JSON response for missing, malformed, expired, wrong,
  or otherwise rejected capabilities without logging or echoing the token;
- rejects HEAD and unsupported methods before invoking the download dependency.

## RED

Command:

```text
npx vitest run tests/http/founder-export-download.test.ts tests/mcp/http-safety.test.ts
```

Observed before production changes:

- exit code 1;
- 5 expected failures in `founder-export-download.test.ts`;
- the success case received 404 instead of 200;
- the four rejected-capability cases received an empty default 404 instead of
  the required safe JSON surface;
- all 9 pre-existing/updated MCP safety tests passed.

## GREEN

Focused command:

```text
npx vitest run tests/http/founder-export-download.test.ts tests/mcp/http-safety.test.ts
```

Result: 2 files passed, 14 tests passed.

Capability/export regression command:

```text
npx vitest run tests/founder-research/download-capability.test.ts tests/founder-research/export-service.test.ts tests/http/founder-export-download.test.ts tests/mcp/http-safety.test.ts
```

Result: 4 files passed, 21 tests passed.

HTTP/auth regression command:

```text
npx vitest run tests/http tests/mcp/http-safety.test.ts tests/auth/http-auth.test.ts tests/oauth/consent-page.test.ts tests/health.test.ts
```

Result: 8 files passed, 31 tests passed.

Additional verification:

- `npm run typecheck`: passed;
- `npm run build`: passed;
- `npm audit --omit=dev`: 0 vulnerabilities;
- `git diff --check`: passed.

## Scope note

Application-level composition of the injected verifier remains intentionally
deferred to Task 13, as specified by the implementation plan. The pre-existing
`.superpowers/sdd/progress.md` modification was not touched.
