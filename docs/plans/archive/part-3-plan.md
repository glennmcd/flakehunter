# FlakeHunter week 3: Next.js dashboard, demo data, deployment

> **Status.** Tasks 1-10 (the API additions, demo data and the web app) were built as planned, with one change: the
> web app uses Next 16, not 15. **The deployment half of this plan (tasks 11-13 and the Fly.io and Vercel
> recommendation below) is superseded by [week3-pr3-aws.md](week3-pr3-aws.md)**: the API runs on AWS Lambda behind
> API Gateway, the dashboard on AWS Amplify Hosting, with the infrastructure in `infra/` (AWS CDK) and the runbook in
> [../deployment.md](../deployment.md). The original text is kept below for the record.

## Context
Week 2 shipped the `/api` REST surface (merged as PR #1). Week 3 puts a real face on it and gets a public demo online:
1. A Next.js dashboard in `apps/web` (overview + test detail) that reuses the API's Zod schemas for typed fetching.
2. A seed script that generates realistic JUnit runs for a fake repo and uploads them through `POST /api/reports`, so the demo exercises the real ingestion path.
3. A deployment recommendation: where the API and web run next to Neon, how secrets are handled, how the upload endpoint stays protected on a public demo.

Decisions confirmed with the user: add an optional `X-FH-Timestamp` upload header for backdating; keep the Vite `apps/dashboard` untouched for now; host web on Vercel and the API on Fly.io (Neon stays the database); put the public web app behind a password gate.

Findings from the code that shape the plan:
- Nothing in the ingest path sets `created_at`; it is always the DB `now()`. Uploading a seed in real time would put every run at one instant and make "history over time" and the `since` filter meaningless. Hence the timestamp header.
- The summary endpoint takes a numeric repo id only, and there is no repo list endpoint. The web app needs `GET /api/repos` to find a repo and its id.
- `@flakehunter/shared-types` exports TypeScript source (`main: src/index.ts`), so Next needs `transpilePackages`.
- The API refuses to boot without `GITHUB_PAT` and `GITHUB_WEBHOOK_SECRET`, and `db/migrate.ts` uses the cwd-relative path `./src/db/migrations` (the bug fixed earlier in `testDb.ts`). Both matter for deployment.
- There is no CORS, no rate limiting, no Dockerfile or host config yet.

## Assumptions (shout at approval if any is wrong)
- Styling: plain CSS with design tokens, light and dark themes, no UI library. I'll use the `impeccable` skill for the visual pass and the `dataviz` skill for the history chart.
- History chart: a server-rendered inline SVG timeline (no chart library), with shape as well as colour per status for accessibility.
- Web data flow: Server Components call the API server-side with `API_TOKEN` held in a server-only env var. The browser never sees a token and never calls the API, so no CORS is needed.
- Pages (`dynamic = "force-dynamic"`, `fetch` with `no-store`): `/` repo list (redirects when there is exactly one repo), `/repos/[repoId]` overview, `/repos/[repoId]/tests/[testId]` detail. Filters live in the URL (`?days=`, `?minRuns=`, `?page=`, `?status=`).
- Tests for the web app use `bun test` with `react-dom/server` `renderToStaticMarkup` (no DOM library), testing the API client, view-model helpers, components and the password gate. Pages themselves are covered by `next build` in CI plus a manual browser check.
- PR split (your call): PR 1 API additions + demo seed, PR 2 web app, PR 3 deployment. Work goes on `feat/week3-*` branches, not `main`.

## Working rule
Same as week 2: no task is done until its tests exist and `bun run lint && bun run typecheck && bun run test` is green. Tests are written with (or before) the code in the same task.

## Task list, in build order

**PR 1: API additions and demo data**

1. **Backdating header.** `X-FH-Timestamp` (optional, ISO-8601 with offset, not more than 5 minutes in the future) added to `uploadReportHeadersSchema` in `packages/shared-types/src/api/reports.ts`. `ingestReport` sets the new run's `created_at`/`run_started_at`; `insertParsedSuites` takes an optional `createdAt` for suites and results. An existing run row is never overwritten. Tests: schema accepts/rejects; ingest stamps run and results when given and uses now otherwise; route returns 400 `validation_error` (details path `headers.x-fh-timestamp`) for a future or malformed value; backdated results land inside/outside the `since` window of `/api/tests/flaky` and `/summary` as expected; duplicates still no-op.
2. **`GET /api/repos`.** Paginated list `{ data: [{ id, fullName, owner, name }], page }` with Zod schemas in `shared-types/src/api/repos.ts`, route in `routes/api/repos.ts`, global Bearer auth as for other reads. Tests: ordering, pagination totals, empty list, auth (via `app.test.ts`).
3. **Demo run generator (pure).** `scripts/demo/generateRuns.ts` and `scripts/demo/junit.ts`, importing only node built-ins (root scripts cannot resolve API deps; see CLAUDE.md). Seeded PRNG (mulberry32) so output is deterministic. Model: about 45 tests across realistic classnames; most always pass; one consistently failing test that is fixed partway (to show non-flaky failures are excluded); one skipped test; about 6 flaky tests with different flake probabilities (including one that only started flaking in the last week and one that stopped three weeks ago); roughly 2 to 4 commits per weekday over `DEMO_DAYS` (default 30); a failing first attempt gets a re-run (attempt 2, same SHA) most of the time so flakes show per commit; some flakes appear as in-suite retries (same test twice, exercising `occurrence_index`); a second report (`unit` and `integration` report keys) on some runs. Run ids and SHAs derive from the seed, so re-seeding is idempotent. XML builder escapes attributes. Tests: determinism for a seed, stable tests never fail, flaky tests fail with roughly their configured rate over many runs, timestamps are ordered and within the window, XML round-trips through `parseJunitXml`.
4. **Seed CLI and end-to-end test.** `scripts/seed-demo.ts` reads `DEMO_API_URL`, `DEMO_UPLOAD_TOKEN`, optional `DEMO_DAYS`/`DEMO_SEED`, uploads sequentially via `fetch` with `X-FH-Timestamp`, and prints created vs duplicate counts. Registering the demo repo and minting its token reuse `seed-dev-repo.ts` and `create-repo-token.ts` (documented in the runbook). Root `test` script gains `bun test scripts`. Test `scripts/demo/seed.e2e.test.ts`: PGlite + `buildApp({ db })` + an `inject` adapter as the uploader; assert the planned flaky tests rank in `/api/tests/flaky`, stable and consistently failing tests do not, history spans many days, and a second seed run returns only `200` duplicates.

**PR 2: web app**

5. **Scaffold `apps/web`.** Next 15 App Router, React 19, TypeScript, `transpilePackages: ["@flakehunter/shared-types"]`, tsconfig extending the base, `.next/` added to `.gitignore`, `next-env.d.ts` committed so typecheck works before a build. Root scripts `dev:web`, `build:web`; `typecheck` and `test` extended to cover it; CI gains a `build:web` step (pages are dynamic so the build makes no API calls). `.env.example` with `API_BASE_URL`, `API_TOKEN`, `SITE_PASSWORD`. `lib/env.ts` validates env with Zod. Tests: env parsing (missing/invalid values fail loudly).
6. **Typed API client.** `lib/api.ts`: `apiGet(path, schema)` fetches with the server-only token, parses with the shared Zod schemas (`flakyTestsResponseSchema`, `repoSummaryResponseSchema`, `testHistoryResponseSchema`, new repos schema), and maps the standard error body to an `ApiClientError` (code, status, requestId). Typed wrappers per endpoint. Tests with a fake `fetch`: success parse, schema mismatch is a loud error, 401/404/400 mapped, network failure.
7. **Password gate.** `middleware.ts` plus a pure `checkBasicAuth(header, password)` using a constant-time compare. If `SITE_PASSWORD` is unset it is open in development and fails closed (503) in production. Tests: no header, wrong, right, malformed base64, unset in dev vs production.
8. **Overview page.** `/repos/[repoId]`: summary cards (runs, tests, pass rate, flaky tests, flaky commits, last run), window selector (7/30/90 days mapped to `since`), flakiest-tests table (test, flake-rate bar, flaky commits / commits run, last flaky) with `minRuns` and pagination, rows link to detail; empty, error and not-found states. View-model helpers (window to `since`, search-param parsing, pagination links) are pure and unit-tested; components tested with `renderToStaticMarkup`.
9. **Test detail page.** `/repos/[repoId]/tests/[testId]`: header with classname/name and a repo breadcrumb, an SVG timeline of results over time (up to 200 points, shape + colour per status, flaky commits highlighted where one SHA has both pass and fail), then a paginated history table (status, short SHA, run link from `htmlUrl`, time, duration, expandable failure message) with `status`/window filters. Helpers (group by SHA, flaky-commit detection, chart point scaling) unit-tested; chart and table components tested for markup, accessible labels, and empty state.
10. **Home and polish.** `/` repo list with redirect for a single repo. A design pass with `impeccable` (responsive, dark mode, focus states, loading/empty/error copy) and a manual browser check against the local API with seeded demo data, with screenshots.

**PR 3: deployment**

11. **Protect upload on a public demo.** `@fastify/rate-limit` scoped to `POST /api/reports`, keyed on a hash of the bearer token (falls back to IP), with `trustProxy` enabled only when `TRUST_PROXY=true` (Fly sets it). Auth already runs before body parsing, and the body limit stays 11 MB. Tests: the Nth+1 request in the window gets 429 in the standard error format (add `rate_limited` to the error codes), limits are per token, other routes are unaffected, and an unauthenticated flood still gets 401 not 413.
12. **Containerise and configure.** `Dockerfile` (oven/bun image pinned to the CI Bun version, installs only the API workspace), `.dockerignore`, `fly.toml` (internal port 3000, `/health` check, `release_command` runs migrations, `auto_stop_machines` with 0 minimum for the demo, region next to Neon), and fix `db/migrate.ts` to resolve migrations from its own location. Verify `docker build` locally if Docker is available. Optional small `scripts/revoke-repo-token.ts` (reuses `revokeRepoToken`) so a leaked demo token can be killed fast.
13. **Runbook and docs.** `docs/deployment.md`: ordered steps, a secrets table (below), rotation, rollback, demo reset (Neon branch reset), and the seed commands. Update README and CLAUDE.md (web app, new endpoints, header, rate limit, deployment pointers).

## Deployment recommendation
- **Database:** keep Neon. Use a separate Neon branch for the demo so synthetic data and the demo's `API_TOKEN` are isolated from your dev data; branches are cheap and resettable.
- **API on Fly.io:** a long-running Fastify server (synchronous webhook processing downloads artifacts) needs a real server, not serverless. One small Bun container, scale to zero for a demo (accept a cold start), region near Neon, `release_command` for migrations. For the demo set random values for `GITHUB_PAT` and `GITHUB_WEBHOOK_SECRET` (required at boot; a random webhook secret means no delivery can ever verify, so the webhook route is inert). Making them optional is a possible follow-up.
- **Web on Vercel:** root directory `apps/web`, Bun install at the workspace root, build `bun run --cwd apps/web build`. Server-side fetch to the Fly URL, so the browser needs no CORS and no token.
- **Secrets and env (set in each platform, never in git; `.env.example` files document names only):**

| Where | Variable | Notes |
| --- | --- | --- |
| Fly (API) | `DATABASE_URL` | demo Neon branch |
| Fly (API) | `API_TOKEN` | read token for the web app; distinct from dev |
| Fly (API) | `GITHUB_PAT`, `GITHUB_WEBHOOK_SECRET` | random placeholders on the demo |
| Fly (API) | `TRUST_PROXY=true` | so rate limiting sees client IPs |
| Vercel (web) | `API_BASE_URL` | the Fly app URL |
| Vercel (web) | `API_TOKEN` | same value as the API's; server-only, marked Sensitive, never `NEXT_PUBLIC_` |
| Vercel (web) | `SITE_PASSWORD` | the demo gate |
| Your shell / CI | `DEMO_UPLOAD_TOKEN` | per-repo upload token for the demo repo, used only by the seed script |

- **Keeping upload protected on a public demo (layers):** per-repo token (sha256 stored, revocable, scoped to the demo repo only); 401 before any body parsing; per-token rate limit; 11 MB body cap; the token never lives in the web app; reads need the global token; the web app is behind the password gate; demo data lives in its own Neon branch so abuse is contained and resettable. Rotation: mint a new upload token, update the secret, revoke the old one; changing `API_TOKEN` means `fly secrets set` (redeploys) and a Vercel env update plus redeploy.
- Deploying itself (flyctl login, `fly secrets set`, Vercel project link) needs your accounts, so the runbook gives exact commands and I do not run them.

## Verification
- Per task: `bun run lint && bun run typecheck && bun run test` green; CI also runs `next build` once the web app lands.
- End to end locally: API on :3000 against a Neon branch, register the demo repo and mint a token, `bun run scripts/seed-demo.ts`, then `bun run dev:web` and walk overview and detail pages in the browser pane (summary totals sensible, planned flaky tests ranked, stable and consistently failing tests absent, history chart spans about 30 days, filters and pagination work, wrong password rejected, unauthenticated upload gets 401, burst of uploads gets 429).
- Seed idempotency: run the seed twice; the second run reports all duplicates.
- After you deploy: seed against the Fly URL, then check the Vercel site end to end.

## Out of scope
Replacing or deleting `apps/dashboard`, OAuth or per-user accounts, token management endpoints, OpenAPI docs, Playwright e2e tests, making the GitHub env vars optional, custom domains.

## Risks
- Next 15 + React 19 under Bun and the CI Bun pin (1.4.2): scaffold first and confirm `next build` passes in CI before building pages.
- `bun install --frozen-lockfile` and a workspace-filtered Docker install need checking; fall back to copying the whole workspace if filtering fails.
- `next-env.d.ts` is committed so typecheck works; if Next rewrites it, accept the diff.
- Backdating lets a token holder write historical data. Acceptable because tokens are per repo and uploads are already trusted; future timestamps are rejected.
- Vercel to Fly cold start can make the first demo page load slow; mention in the runbook or keep one machine warm.