# FlakeHunter — Week 1 Plan

## Context

FlakeHunter is a brand-new project (repo currently empty except a one-line README). It will ingest JUnit XML test reports from GitHub Actions CI runs, store them in Postgres, and flag a test as flaky when it both passes and fails on the same commit SHA. Stack: TypeScript end-to-end — Fastify API, React dashboard, Postgres, bun as package manager/runtime.

This plan is the output of a requirements discussion covering ingestion mechanism, the flaky definition, test identity, multi-repo scope, and auth. Nothing has been built yet — this document defines what week 1 will produce before any code is written.

## Confirmed requirements

1. **Ingestion**: Full GitHub webhook + API fetch flow, built in week 1 (not a stub). Webhook receives `workflow_run` `completed` events → signature verified → GitHub API used to list/download run artifacts → JUnit XML unzipped and parsed → stored.
2. **Flaky definition**: pass + fail on the same commit SHA, **regardless of workflow/job**. Job/workflow metadata is stored for drill-down but is not part of the matching key.
3. **Test identity**: `classname + name` (JUnit `<testcase>` attributes), exact string match, scoped per repo.
4. **Multi-repo**: supported from day one (`repos` table; runs/results scoped to a repo).
5. **Auth/tenancy**: single team/org, simple static API token. No multi-tenant account model, no OAuth login yet.
6. **Week-1 scope**: ingest (full webhook flow) + store + compute flaky tests, minimal API. No dashboard polish — a bare unstyled list view is enough.
7. **Database hosting**: dev and production both point at a hosted free-tier Postgres on **Neon** (connection string via `DATABASE_URL` in `.env`, never committed — `.env` is already gitignored). No local Postgres server, no Docker dependency for running the app. Tests run against **PGlite** (an in-memory/WASM Postgres via `@electric-sql/pglite`) so the test suite needs no running server and no network access — migrations are applied to a fresh PGlite instance per test run.

**Known risk**: the GitHub App/webhook installation flow is the most likely thing to blow the week-1 schedule (external GitHub UI config, not just code). Fallback if behind: skip the installable-App flow, use a plain repo webhook with a hardcoded secret + a classic PAT (`repo` + `actions:read`) instead of App installation tokens. Same pipeline either way. Also scoped down: only `workflow_run` `completed` events, and a single JUnit XML artifact per run assumed.

## Data model (Postgres)

Flaky status is **computed via a SQL view**, not materialized — low volume for a solo-team tool, and a view avoids staleness/refresh-job complexity. Revisit only if query latency becomes a real problem.

```sql
CREATE TABLE repos (
  id              BIGSERIAL PRIMARY KEY,
  github_repo_id  BIGINT NOT NULL UNIQUE,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  full_name       TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE github_installations (
  id                BIGSERIAL PRIMARY KEY,
  installation_id   BIGINT UNIQUE,          -- nullable in PAT-only fallback mode
  account_login     TEXT NOT NULL,
  webhook_secret    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id                BIGSERIAL PRIMARY KEY,
  delivery_id       TEXT NOT NULL UNIQUE,   -- X-GitHub-Delivery, dedupe key
  event_type        TEXT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload           JSONB NOT NULL,
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT
);

CREATE TABLE workflow_runs (
  id                    BIGSERIAL PRIMARY KEY,
  repo_id               BIGINT NOT NULL REFERENCES repos(id),
  github_run_id         BIGINT NOT NULL,
  github_run_attempt    INTEGER NOT NULL DEFAULT 1,
  workflow_name         TEXT NOT NULL,
  head_sha              TEXT NOT NULL,       -- the flaky-matching key
  head_branch           TEXT,
  status                TEXT NOT NULL,
  conclusion            TEXT,
  run_started_at        TIMESTAMPTZ,
  run_completed_at      TIMESTAMPTZ,
  html_url              TEXT,
  artifacts_fetched_at  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, github_run_id, github_run_attempt)
);
CREATE INDEX idx_workflow_runs_repo_sha ON workflow_runs (repo_id, head_sha);

CREATE TABLE test_suites (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  job_name      TEXT,
  suite_name    TEXT NOT NULL,
  file_name     TEXT,
  tests         INTEGER,
  failures      INTEGER,
  errors        INTEGER,
  skipped       INTEGER,
  time_seconds  NUMERIC,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_test_suites_run ON test_suites (run_id);

CREATE TABLE test_cases (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT NOT NULL REFERENCES repos(id),
  classname   TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, classname, name)
);

CREATE TABLE test_results (
  id                BIGSERIAL PRIMARY KEY,
  test_case_id      BIGINT NOT NULL REFERENCES test_cases(id),
  suite_id          BIGINT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  run_id            BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  repo_id           BIGINT NOT NULL REFERENCES repos(id),        -- denormalized for fast lookups
  head_sha          TEXT NOT NULL,                               -- denormalized, the matching key
  occurrence_index  INTEGER NOT NULL DEFAULT 0,                  -- disambiguates reruns/duplicate names within a suite
  status            TEXT NOT NULL CHECK (status IN ('passed','failed','error','skipped')),
  duration_seconds  NUMERIC,
  failure_message   TEXT,
  failure_stack     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_test_results_flaky_lookup ON test_results (repo_id, test_case_id, head_sha, status);
CREATE INDEX idx_test_results_run ON test_results (run_id);

CREATE VIEW flaky_tests AS
SELECT
  tc.repo_id, tc.id AS test_case_id, tc.classname, tc.name, tr.head_sha,
  COUNT(*) FILTER (WHERE tr.status = 'passed') AS pass_count,
  COUNT(*) FILTER (WHERE tr.status IN ('failed','error')) AS fail_count,
  MAX(tr.created_at) AS last_seen_at
FROM test_results tr
JOIN test_cases tc ON tc.id = tr.test_case_id
GROUP BY tc.repo_id, tc.id, tc.classname, tc.name, tr.head_sha
HAVING COUNT(*) FILTER (WHERE tr.status = 'passed') > 0
   AND COUNT(*) FILTER (WHERE tr.status IN ('failed','error')) > 0;
```

**JUnit XML edge cases handled**: nested `<testsuites>` flattened recursively; `failed` vs `error` kept distinct (both count as "not passed" for flaky matching); `skipped` excluded from flaky matching entirely; duplicate test names within one run (retries) disambiguated via `occurrence_index` without losing rows; parameterized tests (`test_foo[param1]`) treated as distinct test identities, which is correct.

## Library choices

| Concern | Choice | Why |
|---|---|---|
| JUnit XML parsing | `fast-xml-parser` | No native deps, fast, handles attributes cleanly for `classname`/`name`/`message` |
| GitHub webhooks + API | `@octokit/webhooks` (signature verify + typed events) + `octokit` (REST + App/PAT auth) | Official, typed, avoids hand-rolled HMAC/REST |
| Postgres + migrations | Drizzle ORM + drizzle-kit | SQL-shaped schema, built-in migration generation, good TS types, one tool instead of ORM+separate migrator |
| Postgres hosting (dev/prod) | Neon free-tier Postgres | Zero local setup (no Docker dependency), plain `postgres://` connection string works directly with `postgres` + `drizzle-orm/postgres-js`; serverless with instant branching if a separate dev/prod branch is wanted later |
| Test database | PGlite (`@electric-sql/pglite`) + `drizzle-orm/pglite` driver | In-memory/WASM Postgres, no running server or network needed for tests, same SQL dialect as real Postgres so schema/migrations/view all behave the same |
| Zip extraction | `fflate` | Tiny, pure-JS, works well with bun; artifacts are always zipped by GitHub's API |
| Fastify structure | Plugin-per-concern + `@fastify/autoload` for routes | Standard convention; `db`, `auth`, `githubClient` as decorators |
| Dashboard auth (week 1) | Static bearer API token via `onRequest` hook | Simplest option meeting requirement; OAuth can be added later without touching the data model |

## Folder structure

Bun workspaces monorepo:

```
FlakeHunter/
├── package.json                  # workspaces: ["apps/*", "packages/*"]
├── bunfig.toml
├── tsconfig.base.json
├── .env.example                  # DATABASE_URL points at Neon; real .env is gitignored
│
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── plugins/
│   │   │   │   ├── db.ts                 # decorates fastify.db (Drizzle instance)
│   │   │   │   └── auth.ts               # API token check
│   │   │   ├── routes/
│   │   │   │   ├── webhooks/github.ts    # POST /webhooks/github
│   │   │   │   ├── repos.ts              # GET /repos
│   │   │   │   ├── runs.ts               # GET /repos/:id/runs
│   │   │   │   └── flaky.ts              # GET /repos/:id/flaky-tests
│   │   │   ├── github/
│   │   │   │   ├── client.ts             # Octokit factory (App or PAT auth)
│   │   │   │   ├── webhookVerify.ts
│   │   │   │   └── artifacts.ts          # list/download run artifacts
│   │   │   ├── ingest/
│   │   │   │   ├── processWorkflowRun.ts # fetch -> unzip -> parse -> persist
│   │   │   │   ├── junitParser.ts
│   │   │   │   └── zipExtract.ts
│   │   │   ├── flaky/flakyQueries.ts
│   │   │   └── db/
│   │   │       ├── schema.ts             # Drizzle schema (source of truth)
│   │   │       └── migrations/
│   │   ├── test/
│   │   │   └── testDb.ts             # spins up a fresh PGlite instance + applies migrations per test run
│   │   └── tsconfig.json
│   │
│   └── dashboard/                 # bare-bones in week 1
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   └── pages/FlakyTestsList.tsx
│       └── tsconfig.json
│
├── packages/
│   └── shared-types/
│       └── src/{index.ts, github.ts, domain.ts}
│
└── scripts/
    └── seed-dev-repo.ts
```

Rationale: `ingest/` (parsing/orchestration) stays separate from `github/` (transport) and `routes/` (HTTP), so the webhook route is a thin adapter (verify → dedupe → delegate) and `processWorkflowRun.ts` is testable without an HTTP server or live GitHub calls.

## Week-1 task list

**Day 1 — Setup + schema**
- Init bun workspace root, scaffold `apps/api` (Fastify + autoload), `apps/dashboard` (Vite + React), `packages/shared-types`
- Provision a free-tier Neon Postgres project (dev database); put the connection string in `.env` (`DATABASE_URL`), keep `.env.example` as the template
- Write Drizzle schema mirroring the SQL above, generate + run initial migration against Neon
- Add `flaky_tests` view via a raw SQL migration (Drizzle doesn't manage views natively)
- Set up `test/testDb.ts`: boots a fresh `@electric-sql/pglite` instance and applies the same Drizzle migrations, for use by all later unit/integration tests — no network or server needed
- Seed a `repos` row + webhook secret for a test repo (against the Neon dev database)

**Day 2 — Webhook ingress + GitHub client**
- Register a webhook on a test repo (plain repo webhook + hardcoded secret, or GitHub App if time allows), pointed at a tunneled local URL
- `POST /webhooks/github`: verify `X-Hub-Signature-256`, dedupe on `X-GitHub-Delivery` into `webhook_events`, return 200 immediately, filter for `workflow_run` / `completed`
- Set up `octokit` client (PAT-authed for week 1)
- Implement artifact listing + zip download

**Day 3 — Parsing + persistence**
- Unzip artifact buffer (fflate), extract `.xml` entries
- Parse JUnit XML (fast-xml-parser), normalize into `{suite, testcases[]}[]`, classify status from `<failure>`/`<error>`/`<skipped>` presence
- `processWorkflowRun.ts`: idempotent upsert of `workflow_runs`, insert `test_suites`, upsert `test_cases`, insert `test_results` with `occurrence_index`
- Wire webhook → `processWorkflowRun`; mark `processed_at`/`processing_error`, never crash the request

**Day 4 — Flaky detection + API**
- `flakyQueries.ts` against the `flaky_tests` view + a summary rollup
- `GET /repos`, `GET /repos/:id/runs`, `GET /repos/:id/flaky-tests`, `GET /repos/:id/tests/:testCaseId/results`
- API token auth hook

**Day 5 — End-to-end validation + bare UI**
- Run a real CI job that fails ~50% of the time on the same SHA across two runs; confirm it surfaces as flaky
- Verify job/workflow differences don't block flaky matching on the same SHA
- Unstyled `FlakyTestsList.tsx` hitting `/repos/:id/flaky-tests`, rendered as a plain table
- README: how to register a repo, set webhook secret, point GitHub at the endpoint
- Buffer day for GitHub webhook/App setup overrun (expected risk area)

**Explicit non-goals for week 1**: no OAuth login, no multi-artifact merge, no `check_run`/`check_suite` support, no materialized flaky flag/refresh job, no dashboard styling/pagination.

## Verification

- Unit-test `junitParser.ts` against sample JUnit XML fixtures covering: nested suites, failure vs error, skipped, parameterized names, duplicate names (reruns). No database needed for these.
- Integration-test `processWorkflowRun.ts` against a fixture artifact zip, using `test/testDb.ts` (PGlite, no running server) to assert rows land correctly in `test_results` and the `flaky_tests` view returns the expected row when a fixture has both a pass and a fail for the same SHA.
- End-to-end: point a real (or test) GitHub repo's webhook at a locally tunneled FlakeHunter instance backed by the Neon dev database, trigger a workflow twice on the same commit with a randomly-failing test, confirm `GET /repos/:id/flaky-tests` reports it.
- Manually hit each new API route with `curl`/HTTPie against the Neon-backed dev server, using the configured bearer token, to confirm auth, shapes, and status codes.
