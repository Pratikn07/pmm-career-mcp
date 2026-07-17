# Task 6 implementation report

## Delivered

- Added public `GET /ready`. It awaits the injected database readiness probe and returns only `{ "status": "ready" }` or the generic `503 { "status": "not_ready" }`; database errors and connection details are never sent to clients.
- Kept `GET /health` independent from the database and outside the OAuth middleware.
- Startup now waits for committed database migrations (inside `createDatabase`) and an explicit readiness probe before opening the HTTP listener. A readiness/startup failure closes the acquired database pool and starts no listener.
- Shutdown shares one promise between `SIGTERM`, `SIGINT`, and direct callers; HTTP close completes before the database pool close begins.
- The image copies the compiled consent assets and committed Postgres migrations, runs as `node`, and removes the SQLite `/app/data` setup and SQLite context rules.
- Docker's `HEALTHCHECK` remains `/health` as a liveness check. `/ready` is documented for Railway deployment-readiness verification; this preserves the design distinction between process liveness and database readiness.

## Test-first evidence

The initial focused run failed as expected: `/ready` returned `404`, its readiness function was not invoked, a rejected readiness probe still allowed the listener, and the Dockerfile still contained `/app/data`. The final focused run passed with 13 tests, including a production-entrypoint failure-closed check.

## Verification

- `npm test -- tests/http/readiness.test.ts tests/runtime/async-composition.test.ts tests/build/dockerfile.test.ts` — 13 passed.
- `npm test` — 30 files, 425 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `docker build -t pmm-career-mcp:supabase .` — passed.
- An isolated container started with a deliberately unreachable fake production database URL exited with status `1`; `docker logs` was empty and did not expose the placeholder database password. The image configuration reports user `node`.

No live Supabase check was attempted because no real project configuration was provided.
