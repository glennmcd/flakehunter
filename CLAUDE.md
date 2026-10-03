# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

FlakeHunter ingests JUnit XML reports from GitHub Actions, stores them in Postgres, and flags a test as flaky when it has both a pass and a fail (or error) on the same commit SHA, regardless of which workflow or job produced the results. It is a Bun workspaces monorepo: `apps/api` (Fastify), `apps/web` (the Next.js dashboard), `packages/shared-types`, plus `infra` (the AWS CDK app that deploys the API to Lambda and the dashboard to Amplify; see `docs/deployment.md`).

## Commands

Use `bun`/`bunx`; there is no npm/yarn setup.

From the repo root:

```bash
bun install
bun run dev:api          # Fastify on :3000 (watch mode)
bun run dev:web          # Next.js on :3001 (apps/web); needs apps/web/.env.local, see .env.example
bun run build:web        # Next.js production build (CI runs it)
bun run db:migrate       # apply migrations to DATABASE_URL (Neon)
bun run db:generate      # generate a migration from schema.ts changes
bun run lint             # Biome: lint, format check, import order (fails on any diff)
bun run lint:fix         # apply Biome's safe fixes
bun run typecheck        # tsc --noEmit for api, infra and web (web runs `next typegen` first)
bun run test             # shared-types, api, web, infra, then scripts tests
bun run synth:infra      # bundle the API Lambda and synthesize both CloudFormation stacks (CI runs it; deploys nothing)
```

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, `build:web` and `synth:infra` on every PR and every push to `main`. Biome config is in `biome.json`: 2-space indent, double quotes, 120-character lines.

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

Revoking an upload token (takes effect on its next request; running it twice is harmless):

```bash
REVOKE_TOKEN=<token> bun run --env-file=apps/api/.env scripts/revoke-repo-token.ts
```

Seeding demo data through the real upload endpoint (see README, "Demo data"):

```bash
DEMO_UPLOAD_TOKEN=<token> bun run seed:demo              # DEMO_API_URL, DEMO_DAYS, DEMO_SEED optional
bun run seed:demo --dry-run                              # generate and count only
```

## Environment

- `apps/api/.env` holds `DATABASE_URL`, `API_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PAT` and `PORT`. Bun loads `.env` from the current working directory, so scripts run outside `apps/api` need `--env-file=apps/api/.env`.
- Scripts in `scripts/` run from the repo root, where `drizzle-orm` and other API dependencies are not installed (they live under `apps/api/node_modules`). Import only from `apps/api/src/...` in those scripts, never from `drizzle-orm` directly, or they fail with "module not found". If you need a query, add or reuse a function in `apps/api/src` (e.g. `resolveRepo`).
- On Lambda the four secrets (`DATABASE_URL`, `API_TOKEN`, `GITHUB_PAT`, `GITHUB_WEBHOOK_SECRET`) come from SSM Parameter Store under `SSM_PARAMETER_PREFIX`, not from `.env`; `RATE_LIMIT_TABLE` and `UPLOAD_RATE_LIMIT_MAX` / `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` are set by the CDK stack.
- Dev and production use a hosted Neon database. Tests never touch it: they use in-memory PGlite and need no server or network.

## Architecture

### Ingestion path

The ingestion path runs from the webhook route through the `ingest/` modules:

1. `routes/webhooks/github.ts` registers a JSON content-type parser scoped to that plugin that keeps `request.rawBody`, then verifies `X-Hub-Signature-256` against it.
2. It inserts the delivery into `webhook_events`, keyed on `X-GitHub-Delivery`. If the insert returns no row, the delivery is a duplicate and processing is skipped.
3. For `workflow_run` events with `action: completed`, it first skips runs that may carry outside code (`github/runSource.ts`), because whoever writes a run's code controls its artifact: a trigger not in `TRUSTED_TRIGGERS` (`push`, `pull_request`, `merge_group`, `schedule`, `workflow_dispatch`; this excludes `pull_request_target`, `workflow_run` and `issue_comment`, which run in the base repo but often relay fork code), or a `workflow_run.head_repository` that is missing or not the repo itself (fork pull requests). Otherwise it looks up the repo by `github_repo_id` and calls `ingest/processWorkflowRun.ts` **synchronously inside the request**, passing the owner and name from the `repos` row, never from the payload.
4. Skips and failures are written to `webhook_events.processing_error` and the route still returns 200. Only fixed text is stored there (skip reasons, `ArtifactRejectedError` messages, or "processing failed; see the API logs"); raw error text goes to the log only.

`processWorkflowRun` then:

- upserts `workflow_runs` on `(repo_id, github_run_id, github_run_attempt)`
- takes the **first** artifact that has not expired, refuses it (`ArtifactRejectedError`, `ingest/limits.ts`) when its listed or downloaded size is over `MAX_ARTIFACT_ZIP_BYTES` (10 MB), downloads the zip and extracts `.xml` entries (`zipExtract.ts`)
- `zipExtract.ts` treats the artifact as untrusted: it streams the zip through fflate's `Unzip`, never inflates non-XML entries, caps the entry count (`MAX_ZIP_ENTRIES`), and stops as soon as the **actual** decompressed XML passes `MAX_REPORT_BYTES` (the archive's declared sizes are not trusted), so a zip bomb is never fully inflated
- parses each file with `junitParser.ts`, which flattens nested `<testsuites>`/`<testsuite>` at any depth
- inserts `test_suites`, upserts `test_cases` on `(repo_id, classname, name)`, and inserts `test_results` (shared with uploads via `ingest/insertParsedSuites.ts`)

`processWorkflowRun` skips artifact ingestion when the run already has a `reports` row (from an upload or an earlier delivery) and records its own `reports` row (`report_key = "webhook-artifact"`) in the same transaction as the results, so redeliveries and upload+webhook never double count.

### Upload path (v1 REST API)

`POST /api/reports` (`routes/api/reports.ts`) takes a raw XML body (`application/xml` or `text/xml`, 11 MB limit) with metadata in headers (`X-FH-Run-Id`, `X-FH-Sha`, optional `X-FH-Run-Attempt`, `X-FH-Branch`, `X-FH-Workflow`, `X-FH-Report-Key`, `X-FH-Timestamp`). `X-FH-Timestamp` (ISO-8601, at most 5 minutes in the future) backdates a new run and its results through `ingestReport`'s `timestamp` and `insertParsedSuites`' `createdAt`; an existing run row keeps its own `created_at`. Without it everything is stamped with the DB's `now()`.

- It authenticates with a per-repo token, not `API_TOKEN`: a route-level `onRequest` hook calls `auth/repoToken.ts` (`findRepoByToken`, sha256 lookup, revocable). The repo comes from the token, never from the request. The hook runs before body parsing and header validation.
- `ingest/ingestReport.ts` does the work in one transaction. Idempotency is the `reports` table, unique on `(run_id, report_key)`; the run is keyed on `(repo_id, github_run_id, attempt)`. A repeat returns 200 with the original counts (stored on the `reports` row); a first upload returns 201. A SHA that contradicts an existing run is a 400, and an existing run row (e.g. from the webhook) is reused, not overwritten.
- Unparseable bodies or reports with no `<testsuite>` are `invalid_report` (422) and leave nothing behind.
- **gzip:** `Content-Encoding: gzip` is accepted (`http/gzipBody.ts`, a `preParsing` hook that runs after the token check). The 11 MB limit applies to the **decompressed** size, enforced while streaming so a decompression bomb is destroyed at the limit (`413 payload_too_large`); bad gzip data is a `400`, and any other encoding is a `400`. This matters because a Lambda request body is capped near 6 MB (about 4.5 MB raw after base64), so large reports must be sent compressed; `scripts/seed-demo.ts` and the README snippet do.
- **Rate limit:** an `onRequest` hook (`plugins/rateLimit.ts`, `ratelimit/`) runs before the token lookup and counts each request under its source IP and, if it sends one, a sha256 of its bearer token (the raw token is never stored). Past `UPLOAD_RATE_LIMIT_MAX` (default 120) per `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` (default 60) it answers `429 rate_limited` with `Retry-After`. Counting by IP is what stops a flood of invented tokens. The store is a `RateLimitStore`: in memory for tests and local runs, a DynamoDB fixed-window counter (atomic `ADD`, TTL) on Lambda, where `buildApp` refuses to start without `RATE_LIMIT_TABLE`. A failing store lets requests through and logs a warning. `buildApp({ rateLimit })` overrides it in tests; tests that upload many reports from one address (the seed e2e) raise the limit.

Read endpoints (global `API_TOKEN`), all under `/api`:

- `GET /api/tests/flaky?repo=&since=&minRuns=` (`flaky/flakeRateQueries.ts`): flake rate = flaky SHAs / SHAs run in the window, skipped results ignored, only tests with at least `minRuns` (default 5) SHAs and one flaky SHA.
- `GET /api/tests/:id/history` (`history/testHistoryQueries.ts`): newest-first results; never returns `failureStack`.
- `GET /api/repos/:id/summary` (`summary/repoSummaryQueries.ts`): windowed totals; `lastRunAt` ignores the window.
- `GET /api/repos` (`repos/repoQueries.ts`): paginated repo list ordered by full name; the web app needs it to find a repo's numeric id.

### Demo data

`scripts/demo/` generates a fake CI history and `scripts/seed-demo.ts` uploads it through `POST /api/reports`:

- `catalog.ts` is the fake service's test list with a behaviour per test (`stable`, `skipped`, `flaky` with probability, in-suite retries and an optional active window, `failing-until` a fix date). `generateRuns.ts` turns it into runs; `junit.ts` builds the XML; `seedDemo.ts` has config parsing, the HTTP uploader and the retrying seeder.
- The generator is pure and deterministic. Every random draw comes from a PRNG keyed on (seed, calendar day, commit, attempt), never the clock, and windows like "flaky only in the last 7 days" count whole UTC calendar days. Regenerating later therefore reproduces earlier runs exactly, so re-seeding returns `200` duplicates. Run ids embed the seed, so a new `DEMO_SEED` is new data.
- These files import only node built-ins (root scripts cannot resolve API dependencies). Tests may import from `apps/api`: `seed.e2e.test.ts` uploads the full history through `buildApp()` over PGlite and checks the API's flaky ranking and summary against what the generator produced.

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

- **Explicit route registration:** `routes/index.ts` lists every route plugin with its URL prefix (`routeModules`) and `app.ts` registers them through `registerRoutes`. There is no autoload: a bundler (esbuild for Lambda) cannot see files imported from disk at runtime. Adding a route file means adding an entry there; `routes/routes.test.ts` fails if a file on disk is missing from the list.
- **Route prefixing:** files in `routes/api/` are mounted at `/api` and `routes/webhooks/github.ts` at `/webhooks` (it registers `/github` to serve `/webhooks/github`; writing the full path double-prefixes it). Keep `/api` route files flat in `routes/api/` and write the path after `/api` (e.g. `/tests/flaky`).
- **App wiring:** `app.ts` exports `buildApp({ db?, logger? })` (zod validator/serializer compilers, error handler, db, auth, github, explicit routes); `index.ts` only calls it and listens. `app.test.ts` builds the real app over PGlite.
- **Auth hook:** `plugins/auth.ts` is a global `onRequest` hook (wrapped in `fastify-plugin`) that requires `Authorization: Bearer <API_TOKEN>`.
  - It exempts `/webhooks/github`, `/health` and `/api/reports` by exact match on the path part of `request.url`. `routeOptions.url` is not reliable there, and the hook also runs for unmatched routes. `/api/reports` does its own per-repo token check.
  - New public routes must be added to that exemption.
- **Decorators:** `plugins/db.ts` and `plugins/github.ts` decorate `fastify.db` (Drizzle over postgres-js) and `fastify.github` (Octokit, authenticated with a PAT).
- **Lambda entry:** `src/lambda.ts` exports `handler` (`createHandler` in `lambda/handler.ts`): it reads the secrets from SSM (`lambda/secrets.ts`, `loadSecrets`) into `process.env`, builds the app once per execution environment and wraps it with `@fastify/aws-lambda`. The adapter must wrap the app **before** `app.ready()`. A failed start is not cached. `index.ts` stays the long-running entry for local runs. Lambda runs Node 22, not Bun; the source uses no Bun-only APIs, so keep it that way.
- **DB options:** `db/options.ts` (`dbOptionsFor`) gives postgres-js one connection plus timeouts on Lambda and turns off prepared statements for Neon's `-pooler` host. Migrations (`db/migrator.ts`, `bun run db:migrate`) resolve their folder from their own file and should use the direct (non-pooled) connection string.

### DB typing for tests

- Domain functions take `AnyDb` from `db/client.ts` (a generic `PgDatabase`), not the postgres-js-specific `Db`. That lets the same code run against the PGlite instance from `apps/api/test/testDb.ts`. Keep new DB-touching functions on `AnyDb`.
- `createTestDb()` returns a fresh in-memory database with all migrations applied.
- Tests fake the GitHub client with a plain object cast to `GithubClient`; see `processWorkflowRun.test.ts`. App-level tests pass it as `buildApp({ github })`; see `routes/webhooks/github.test.ts`, which also signs payloads.
- With PGlite, `db.execute(sql...)` returns `{ rows }`, not an array. Because the shapes differ per driver, production query code uses the Drizzle query builder (including `$with` CTEs); raw `execute` is only for assertions in tests.
- `test/fixtures.ts` has `seedRepo`, `seedRun` and `seedResult` (creates the test case, run and suite for you), plus `daysAgo` and `sha`. `test/apiApp.ts` builds a small app for route tests. Assert HTTP bodies with `res.json<unknown>()` when passing them straight to `toEqual`, or the types collapse to `undefined`.

### Web app (`apps/web`)

Next.js (App Router, currently 16.x with Turbopack) and React 19. Server Components call the API with the server-only `API_TOKEN`, so no token or CORS is involved in the browser.

- **Env:** `lib/env.ts` (`loadEnv`) validates `API_BASE_URL`, `API_TOKEN` and `SITE_PASSWORD` with Zod. Its errors name variables but never values. Never prefix these with `NEXT_PUBLIC_`.
- **Shared schemas:** the web app imports Zod schemas from `@flakehunter/shared-types` (`transpilePackages` in `next.config.ts`, since the package ships TypeScript source). Turbopack cannot resolve `./x.js` specifiers to `.ts` files, so imports inside `packages/shared-types/src` are extensionless (`from "./common"`). Do not add `.js` suffixes there; the build breaks as soon as a page imports the package.
- **Imports in `apps/web`:** extensionless, like shared-types (the `.js` suffix convention is for the Node-style apps).
- **Pages are dynamic:** pages `export const dynamic = "force-dynamic"` because they read live API data, so `next build` makes no API calls and CI needs no secrets.
- **Types:** `next-env.d.ts` and `.next/` are git-ignored; `bun run typecheck` runs `next typegen` first to generate them. TypeScript comes from the repo root (5.x); do not add a separate `typescript` to `apps/web`.
- **Pages and helpers:** `/` (`lib/home.ts` `decideHome`: redirect on exactly one repo unless `?list=1`; it returns a result instead of throwing so `redirect()` is called outside try/catch), `/repos/[repoId]` (`lib/overview.ts`, `lib/overviewData.ts`), `/repos/[repoId]/tests/[testId]` (`lib/history.ts` has the flaky-commit and chart-geometry helpers, `lib/historyData.ts`). Filters live in the URL and are parsed defensively (bad values fall back to defaults); filter forms are plain GET forms, no client JS. `lib/errors.ts` maps API errors to fixed user-facing text, never the raw message.
- **Styling:** one plain `app/globals.css` with light/dark tokens, no UI library. Test statuses use `--st-*` colours (checked for colour-blind separation) plus a distinct shape each; the amber `--accent` means "flaky". Do not add shadows or cards; elevation is a 1px border.
- **Tests:** `bun test` with `react-dom/server`'s `renderToStaticMarkup` for components, no DOM library; pure helpers get plain unit tests. Pages themselves are covered by `next build` in CI plus a manual browser check.
- **Password gate:** `src/proxy.ts` is Next 16's `proxy` (the renamed `middleware`; docs in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`). It runs on the Node.js runtime with no `matcher`, so it covers every request including `/_next/static`; do not add a matcher that exempts paths. The logic is pure and tested in `lib/basicAuth.ts` (`checkBasicAuth`: constant-time compare of the password only, username ignored; `gateDecision`). With `SITE_PASSWORD` set it is enforced in every environment; unset, it is open only when `NODE_ENV` is `development` or `test`, and otherwise returns 503 (fail closed). It reads `process.env` directly, not `loadEnv`, so a missing API variable cannot disable it.
- **No generated agent files:** `next dev` would write `AGENTS.md` and `CLAUDE.md` into `apps/web`; `agentRules: false` in `next.config.ts` turns that off. Keep it off so this root file stays the single source.

### AWS deployment (`infra/`)

A CDK app (TypeScript) with two stacks in us-east-2: `FlakeHunterApi` (Lambda, API Gateway HTTP API on the `$default` stage throttled to 10 requests per second by default, DynamoDB rate-limit table, least-privilege IAM, optional cost budget) and `FlakeHunterWeb` (Amplify Hosting app and branch). The runbook is `docs/deployment.md`; the agent never runs `cdk deploy` or `cdk bootstrap`, you do.

- **Bundling:** `scripts/bundle-api.ts` (esbuild) builds `apps/api/src/lambda.ts` into `infra/dist/api`; `cdk.json`'s `build` runs it before every synth. CDK's own `NodejsFunction` bundler is not used (it shells out to the package manager and fails with Bun on Windows).
- **Node, not Bun, for CDK:** CDK's template validation takes about 100 seconds to start in Bun and about 1 second in Node, so `cdk.json` runs the app with `node --import tsx`. Tests (`bun test` in `infra/`) synthesize every scenario in one Node subprocess (`test/synth-worker.ts`) and assert on the resulting templates; `test/bundle.test.ts` loads the real bundle under Node.
- **Secrets never pass through CloudFormation:** the four API secrets are SSM SecureString parameters created by hand; the dashboard's `ApiToken` and `SitePassword` are NoEcho parameters; the GitHub token is a Secrets Manager dynamic reference.
- **Keep in sync:** `SECRET_NAMES` in `infra/lib/api-stack.ts` and `apps/api/src/lambda/secrets.ts` (a test checks), and the Bun version in `BUILD_SPEC` and in the CI workflow (a test checks).
- **AWS rules:** the block at the end of this file (from the AWS Agent Toolkit) applies; in short, all regional resources go in the project's one Region, us-east-2.

## Local webhook testing

- GitHub must reach `/webhooks/github`. Use a quick tunnel:
  ```bash
  bun run tunnel
  ```
  `scripts/tunnel.ts` wraps `cloudflared tunnel --url http://localhost:3000`, passes its output through, and writes `<tunnel URL>/webhooks/github` to the git-ignored `scripts/webhook-url.txt` (overwritten each run; logic and tests in `scripts/tunnel/`). The hostname changes on every start, so update the webhook URL each time (see README).
- The test fixture repo is `glennmcd/flakehunter-test-fixture`. Its "maybe flaky test" fails about half the time, so re-running `test.yml` on the same commit produces flaky data.
- On Windows, a background server can keep holding port 3000 after its shell is gone. Find it with `netstat -ano` and stop it with `taskkill //F //PID <pid>`; bash `kill` uses different PIDs.

## Scope limits (intentional)

- Only `workflow_run` `completed` events are handled, and one artifact per run is assumed.
- Read auth is a single static token; upload tokens are per repo but have no management endpoint (mint with `scripts/create-repo-token.ts`, revoke with `scripts/revoke-repo-token.ts`). There is no OAuth.
- Upload rate limiting exists (per IP and per token); reads are limited only by API Gateway throttling. There is no OpenAPI document for `/api`. The week-1 routes (`/repos`, `/flaky`, `/runs`, `/tests`) no longer have a caller since the old Vite dashboard was removed (`apps/web` uses the v1 API); removing them is a follow-up.
- Webhook processing still runs inside the request (artifact download and unzip). That suits small demo artifacts; a queue (SQS) is the follow-up for anything larger, since GitHub expects an answer within 10 seconds.
- The design plan is in `docs/plans/` and `C:\Users\glenn\.claude\plans\i-m-building-flakehunter-it-virtual-sutton.md`.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion

help_level: HIGH
<!-- END AWS Agent Toolkit rules -->
