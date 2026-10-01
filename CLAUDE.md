# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

FlakeHunter ingests JUnit XML reports from GitHub Actions, stores them in Postgres, and flags a test as flaky when it has both a pass and a fail (or error) on the same commit SHA, regardless of which workflow or job produced the results. It is a Bun workspaces monorepo: `apps/api` (Fastify), `apps/dashboard` (Vite + React), `packages/shared-types`.

## Commands

Use `bun`/`bunx`; there is no npm/yarn setup.

From the repo root:

```bash
bun install
bun run dev:api          # Fastify on :3000 (watch mode)
bun run dev:dashboard    # Vite on :5173, proxies /api -> :3000
bun run db:migrate       # apply migrations to DATABASE_URL (Neon)
bun run db:generate      # generate a migration from schema.ts changes
bun run lint             # Biome: lint, format check, import order (fails on any diff)
bun run lint:fix         # apply Biome's safe fixes
bun run typecheck        # tsc --noEmit for api and dashboard
bun run test             # shared-types tests, then all api tests
```

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck` and `test` on every PR and every push to `main`. Biome config is in `biome.json`: 2-space indent, double quotes, 120-character lines.

To run a subset of tests, use `bun test` with a path or name. The test DB helper resolves migrations relative to its own file, so the working directory does not matter (this also holds when debugging):

```bash
bun test apps/api/src/ingest/junitParser.test.ts    # one file
bun test apps/api -t "flattens nested"              # by test name
```

Every new function or route ships with tests in the same change; run `bun run lint && bun run typecheck && bun run test` before moving on.

Seeding a repo row (required before ingestion works for that repo):

```bash
SEED_REPO_OWNER=<owner> SEED_REPO_NAME=<repo> SEED_REPO_GITHUB_ID=<id> bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
```

Minting a per-repo upload token for `POST /api/reports` (printed once; only its sha256 is stored):

```bash
TOKEN_REPO_FULL_NAME=<owner>/<repo> bun run --env-file=apps/api/.env scripts/create-repo-token.ts
```

## Environment

- `apps/api/.env` holds `DATABASE_URL`, `API_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PAT` and `PORT`. Bun loads `.env` from the current working directory, so scripts run outside `apps/api` need `--env-file=apps/api/.env`.
- `apps/dashboard/.env` holds `VITE_API_TOKEN`, which must equal `API_TOKEN`.
- Dev and production use a hosted Neon database. Tests never touch it: they use in-memory PGlite and need no server or network.

## Architecture

### Ingestion path

The ingestion path runs from the webhook route through the `ingest/` modules:

1. `routes/webhooks/github.ts` registers a JSON content-type parser scoped to that plugin that keeps `request.rawBody`, then verifies `X-Hub-Signature-256` against it.
2. It inserts the delivery into `webhook_events`, keyed on `X-GitHub-Delivery`. If the insert returns no row, the delivery is a duplicate and processing is skipped.
3. For `workflow_run` events with `action: completed`, it looks up the repo by `github_repo_id` and calls `ingest/processWorkflowRun.ts` **synchronously inside the request**.
4. Failures are written to `webhook_events.processing_error` and the route still returns 200.

`processWorkflowRun` then:

- upserts `workflow_runs` on `(repo_id, github_run_id, github_run_attempt)`
- takes the **first** artifact only, downloads the zip and extracts `.xml` entries (`zipExtract.ts`)
- parses each file with `junitParser.ts`, which flattens nested `<testsuites>`/`<testsuite>` at any depth
- inserts `test_suites`, upserts `test_cases` on `(repo_id, classname, name)`, and inserts `test_results` (shared with uploads via `ingest/insertParsedSuites.ts`)

`processWorkflowRun` skips artifact ingestion when the run already has a `reports` row (from an upload or an earlier delivery) and records its own `reports` row (`report_key = "webhook-artifact"`) in the same transaction as the results, so redeliveries and upload+webhook never double count.

### Upload path (v1 REST API)

`POST /api/reports` (`routes/api/reports.ts`) takes a raw XML body (`application/xml` or `text/xml`, 11 MB limit) with metadata in headers (`X-FH-Run-Id`, `X-FH-Sha`, optional `X-FH-Run-Attempt`, `X-FH-Branch`, `X-FH-Workflow`, `X-FH-Report-Key`).

- It authenticates with a per-repo token, not `API_TOKEN`: a route-level `onRequest` hook calls `auth/repoToken.ts` (`findRepoByToken`, sha256 lookup, revocable). The repo comes from the token, never from the request. The hook runs before body parsing and header validation.
- `ingest/ingestReport.ts` does the work in one transaction. Idempotency is the `reports` table, unique on `(run_id, report_key)`; the run is keyed on `(repo_id, github_run_id, attempt)`. A repeat returns 200 with the original counts (stored on the `reports` row); a first upload returns 201. A SHA that contradicts an existing run is a 400, and an existing run row (e.g. from the webhook) is reused, not overwritten.
- Unparseable bodies or reports with no `<testsuite>` are `invalid_report` (422) and leave nothing behind.

Read endpoints (global `API_TOKEN`), all under `/api`:

- `GET /api/tests/flaky?repo=&since=&minRuns=` (`flaky/flakeRateQueries.ts`): flake rate = flaky SHAs / SHAs run in the window, skipped results ignored, only tests with at least `minRuns` (default 5) SHAs and one flaky SHA.
- `GET /api/tests/:id/history` (`history/testHistoryQueries.ts`): newest-first results; never returns `failureStack`.
- `GET /api/repos/:id/summary` (`summary/repoSummaryQueries.ts`): windowed totals; `lastRunAt` ignores the window.

`perShaCte` in `flaky/flakeRateQueries.ts` is the single definition of "flaky SHA" for the ranking and the summary. The older `flaky_tests` view still backs the week-1 `/repos/:id/flaky-tests` routes, which are unchanged.

Zod schemas for all `/api` requests and responses live in `packages/shared-types/src/api/`. Every `/api` error uses one body, `{ error: { code, message, details? }, requestId }`, produced by `plugins/errorHandler.ts` from `ApiError` (`api/errors.ts`). Lists use `?limit=&offset=` and return `{ data, page: { limit, offset, total } }`.

Test identity is `classname + name`, scoped per repo. Duplicate names within one suite (retries) get an increasing `occurrence_index`. `repo_id` and `head_sha` are denormalized onto `test_results` so the flaky query needs no joins to runs.

### Flaky detection is a SQL view, not stored state

`flaky_tests` is defined in the hand-written migration `src/db/migrations/0001_flaky_tests_view.sql`. It groups `test_results` by `(repo_id, test_case_id, head_sha)` and keeps groups with at least one `passed` and at least one `failed`/`error`.

`schema.ts` mirrors the view with `pgView(...).existing()` so it can be queried with types, while drizzle-kit ignores it. To change the view:

1. Create a custom migration: `bunx drizzle-kit generate --custom --name=<name>`.
2. Update the `pgView` columns to match.

`flaky/flakyQueries.ts` reads the view. `GET /repos/:id/flaky-tests?summary=true` returns a per-test rollup across SHAs.

### Fastify conventions that have caused bugs

- **Route prefixing:** `@fastify/autoload` prefixes routes with their directory name. `routes/webhooks/github.ts` registers `/github` to serve `/webhooks/github`; writing the full path double-prefixes it. Keep `/api` route files flat in `routes/api/` and write the path after `/api` (e.g. `/tests/flaky`), so a subdirectory does not add another prefix.
- **Test files beside routes:** autoload would import `*.test.ts` as route plugins, so `app.ts` sets `ignorePattern` for them. Keep that if you touch the autoload options.
- **App wiring:** `app.ts` exports `buildApp({ db?, logger? })` (zod validator/serializer compilers, error handler, db, auth, github, autoload); `index.ts` only calls it and listens. `app.test.ts` builds the real app over PGlite.
- **Auth hook:** `plugins/auth.ts` is a global `onRequest` hook (wrapped in `fastify-plugin`) that requires `Authorization: Bearer <API_TOKEN>`.
  - It exempts `/webhooks/github`, `/health` and `/api/reports` by exact match on the path part of `request.url`. `routeOptions.url` is not reliable there, and the hook also runs for unmatched routes. `/api/reports` does its own per-repo token check.
  - New public routes must be added to that exemption.
- **Decorators:** `plugins/db.ts` and `plugins/github.ts` decorate `fastify.db` (Drizzle over postgres-js) and `fastify.github` (Octokit, authenticated with a PAT).

### DB typing for tests

- Domain functions take `AnyDb` from `db/client.ts` (a generic `PgDatabase`), not the postgres-js-specific `Db`. That lets the same code run against the PGlite instance from `apps/api/test/testDb.ts`. Keep new DB-touching functions on `AnyDb`.
- `createTestDb()` returns a fresh in-memory database with all migrations applied.
- Tests fake the GitHub client with a plain object cast to `GithubClient`; see `processWorkflowRun.test.ts`.
- With PGlite, `db.execute(sql...)` returns `{ rows }`, not an array. Because the shapes differ per driver, production query code uses the Drizzle query builder (including `$with` CTEs); raw `execute` is only for assertions in tests.
- `test/fixtures.ts` has `seedRepo`, `seedRun` and `seedResult` (creates the test case, run and suite for you), plus `daysAgo` and `sha`. `test/apiApp.ts` builds a small app for route tests. Assert HTTP bodies with `res.json<unknown>()` when passing them straight to `toEqual`, or the types collapse to `undefined`.

### Dashboard

Week-1 bare-bones: a single `FlakyTestsList.tsx` page with `REPO_ID` hardcoded to `1`. It defines its own `FlakyTest` type rather than importing `@flakehunter/shared-types`.

## Local webhook testing

- GitHub must reach `/webhooks/github`. Use a quick tunnel:
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  The hostname changes on every start, so update the webhook URL each time (see README).
- The test fixture repo is `glennmcd/flakehunter-test-fixture`. Its "maybe flaky test" fails about half the time, so re-running `test.yml` on the same commit produces flaky data.
- On Windows, a background server can keep holding port 3000 after its shell is gone. Find it with `netstat -ano` and stop it with `taskkill //F //PID <pid>`; bash `kill` uses different PIDs.

## Scope limits (intentional)

- Only `workflow_run` `completed` events are handled, and one artifact per run is assumed.
- Read auth is a single static token; upload tokens are per repo but have no management endpoint (mint with the script, revoke with `revokeRepoToken`). There is no OAuth.
- No rate limiting or OpenAPI document for `/api` yet, and the dashboard still uses the week-1 routes.
- The design plan is in `docs/plans/` and `C:\Users\glenn\.claude\plans\i-m-building-flakehunter-it-virtual-sutton.md`.
