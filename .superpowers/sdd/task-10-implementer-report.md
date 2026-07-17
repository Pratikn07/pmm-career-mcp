# Task 10 implementer report

## Scope completed

- Added `jose` and stateless bearer-token protection for hosted MCP requests.
- Added OIDC discovery plus remote-JWKS signature verification. Tokens must have the configured issuer, audience, a required unexpired `exp`, and the single configured subject.
- Added OAuth protected-resource metadata at `/.well-known/oauth-protected-resource`, with canonical resource URL, authorization server, supported scope, and documentation URL.
- Kept `/health` and protected-resource metadata public. Authentication applies only to `/mcp`, before parsing request JSON, while preserving the existing request-ID middleware.
- Returned generic denial bodies only. 401 responses include a `WWW-Authenticate` protected-resource-metadata reference; 403 subject denials expose no claims or identity-provider details.
- Added production fail-closed configuration checks for OAuth mode, HTTPS issuer, audience, allowed subject, 64-hex token-encryption key, and HTTPS base URL. Production also rejects non-HTTPS JWKS metadata and all OIDC/JWKS redirects. `AUTH_MODE=none` remains allowed only outside production.

## TDD evidence

- Wrote resource-auth, HTTP-auth, and production-config tests before implementation. The initial run failed because `src/auth/resource-auth.ts`, metadata routing, and production guards did not yet exist.
- Tests use a generated local RS256 key pair, local OIDC discovery endpoint, and local JWKS endpoint only. No real identity provider or network credential was used.

## Verification

Passed:

```text
npm test -- tests/auth tests/config.test.ts tests/mcp/http-safety.test.ts  # 4 files, 16 tests
npm run typecheck
npm run build
npm audit --omit=dev                                                       # 0 vulnerabilities
npm test                                                                    # 22 files, 339 tests
git diff --check
```

## Commit

- `264e4d5 feat: protect hosted MCP with OAuth`
- `eeb6092 fix: require exp and HTTPS OAuth endpoints`

## Notes for the next task

- `src/index.ts` still uses the Task 1 placeholder MCP handler. Task 11 should compose the real service dependencies and use `mcpServerFactory` for the deployed MCP server.
- Production deployers must supply an HTTPS `OIDC_ISSUER`, `OIDC_AUDIENCE`, `ALLOWED_SUBJECT`, a 64-character hex `TOKEN_ENCRYPTION_KEY`, and an HTTPS `BASE_URL`; no values were added to source control.
