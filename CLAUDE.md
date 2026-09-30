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
bun run test             # all api tests
```

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck` and `test` on every PR and every push to `main`. Biome config is in `biome.json`: 2-space indent, double quotes, 120-character lines.

To run a subset of tests, work from `apps/api`, because the test DB helper resolves migrations by the relative path `./src/db/migrations`:

```bash
cd apps/api
bun test src/ingest/junitParser.test.ts    # one file
bun test -t "flattens nested"              # by test name
```

Seeding a repo row (required before ingestion works for that repo):

```bash
SEED_REPO_OWNER=<owner> SEED_REPO_NAME=<repo> SEED_REPO_GITHUB_ID=<id> bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
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
- inserts `test_suites`, upserts `test_cases` on `(repo_id, classname, name)`, and inserts `test_results`

Test identity is `classname + name`, scoped per repo. Duplicate names within one suite (retries) get an increasing `occurrence_index`. `repo_id` and `head_sha` are denormalized onto `test_results` so the flaky query needs no joins to runs.

### Flaky detection is a SQL view, not stored state

`flaky_tests` is defined in the hand-written migration `src/db/migrations/0001_flaky_tests_view.sql`. It groups `test_results` by `(repo_id, test_case_id, head_sha)` and keeps groups with at least one `passed` and at least one `failed`/`error`.

`schema.ts` mirrors the view with `pgView(...).existing()` so it can be queried with types, while drizzle-kit ignores it. To change the view:

1. Create a custom migration: `bunx drizzle-kit generate --custom --name=<name>`.
2. Update the `pgView` columns to match.

`flaky/flakyQueries.ts` reads the view. `GET /repos/:id/flaky-tests?summary=true` returns a per-test rollup across SHAs.

### Fastify conventions that have caused bugs

- **Route prefixing:** `@fastify/autoload` prefixes routes with their directory name. `routes/webhooks/github.ts` registers `/github` to serve `/webhooks/github`; writing the full path double-prefixes it.
- **Auth hook:** `plugins/auth.ts` is a global `onRequest` hook (wrapped in `fastify-plugin`) that requires `Authorization: Bearer <API_TOKEN>`.
  - It exempts `/webhooks/github` and `/health` by matching `request.url`. `routeOptions.url` is not reliable there, and the hook also runs for unmatched routes.
  - New public routes must be added to that exemption.
- **Decorators:** `plugins/db.ts` and `plugins/github.ts` decorate `fastify.db` (Drizzle over postgres-js) and `fastify.github` (Octokit, authenticated with a PAT).

### DB typing for tests

- Domain functions take `AnyDb` from `db/client.ts` (a generic `PgDatabase`), not the postgres-js-specific `Db`. That lets the same code run against the PGlite instance from `apps/api/test/testDb.ts`. Keep new DB-touching functions on `AnyDb`.
- `createTestDb()` returns a fresh in-memory database with all migrations applied.
- Tests fake the GitHub client with a plain object cast to `GithubClient`; see `processWorkflowRun.test.ts`.
- With PGlite, `db.execute(sql...)` returns `{ rows }`, not an array.

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

## Week-1 scope limits (intentional)

- Only `workflow_run` `completed` events are handled.
- One artifact per run is assumed.
- Auth is a single static token; there is no OAuth.
- The design plan is in `docs/plans/` and `C:\Users\glenn\.claude\plans\i-m-building-flakehunter-it-virtual-sutton.md`.
