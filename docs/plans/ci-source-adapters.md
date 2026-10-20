# CI source adapters

**Status:** Draft, for review. No code changes until this is agreed.

This plan separates two things FlakeHunter currently treats as one, because today both are GitHub:

- **Host:** where a repository's code lives and what identifies it (`github`, later `gitlab`, `bitbucket`, …). Stored
  as `repos.host`.
- **CI source:** the system that ran a workflow and holds its artifacts (`github_actions`, later `gitlab_ci`,
  `jenkins`, `circleci`, …). Stored per run as `workflow_runs.ci_source`.

A GitHub repository can be built by GitHub Actions, by Jenkins, or by both, so a repository has one host and its runs
can come from several CI sources. CI-specific code moves behind a `CiSourceAdapter` interface, with
`GithubActionsAdapter` as the only implementation.

Behaviour does not change: every repository today is `github` and every run is `github_actions`. The upload API, the
OpenAPI contract, the dashboard and flaky detection stay as they are; the host and CI source are exposed in
[API v2](api-v2.md). This is the groundwork for GitLab (flakehunter-airflow's
[GitLab ingest](https://github.com/glennmcd/flakehunter-airflow/blob/main/docs/plans/gitlab-ingest.md)) and for CI-only systems, neither
of which is part of this change.

Neither term is the ingestion channel (webhook or upload); that is already carried by `reports.report_key`.

## Where GitHub is wired in today

| Area | Files | Coupling | Becomes |
|---|---|---|---|
| API client | `github/client.ts`, `plugins/github.ts`, `app.ts` | Octokit decorated as `fastify.github`; `buildApp({ github })` | CI |
| Artifacts | `github/artifacts.ts` | Octokit artifact listing and download | CI |
| Trust | `github/runSource.ts` | trigger allow-list and fork check on the webhook payload | CI |
| Webhook | `routes/webhooks/github.ts`, `github/webhookVerify.ts` | signature, delivery id, payload → `processWorkflowRun` | CI |
| Ingestion | `ingest/processWorkflowRun.ts` | takes a `GithubClient` and owner/repo names | CI |
| Repo identity | `db/schema.ts`, `api/resolveRepo.ts` | `repos.githubRepoId` unique; `full_name` unique across all repos | host |
| Run identity | `db/schema.ts`, `ingest/ingestReport.ts` | runs unique on `(repo_id, github_run_id, github_run_attempt)` | CI |
| Queries | `history/testHistoryQueries.ts`, `history/testFailuresQueries.ts` | select `githubRunId` | CI |
| Types | `shared-types/src/domain.ts`, `shared-types/src/github.ts` | `githubRepoId`, `githubRunId`; webhook payload type | both |
| Scripts | `scripts/seed-dev-repo.ts`, `scripts/create-repo-token.ts` | `SEED_REPO_GITHUB_ID`, `github_installations`; repo by `owner/name` | host |
| Tests | `processWorkflowRun.test.ts`, `routes/webhooks/github.test.ts`, `test/fixtures.ts` | fake Octokit cast to `GithubClient` | CI |

## Target design

### Types

```ts
// packages/shared-types/src/sources.ts
export type RepoHost = "github";
export type CiSource = "github_actions";

/** The CI source a run is assumed to come from when nothing says otherwise. */
export const DEFAULT_CI_SOURCE: Record<RepoHost, CiSource> = { github: "github_actions" };
```

Both are shared so the API, scripts and (through API v2) the dashboard use one definition. Each new value is added
here and in the matching database check constraint, in the change that introduces it.

Hosts get no adapter class: FlakeHunter never calls a host's API for anything but CI data today. A host adapter
(commit links, repository metadata) can be added when something needs it.

### The CI adapter

```ts
// apps/api/src/ci/types.ts
export interface CiRepo {
  id: number; // repos.id
  host: RepoHost;
  externalRepoId: number;
  owner: string;
  name: string;
}

export interface ReportArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
}

export interface CiSourceAdapter {
  readonly ciSource: CiSource;
  /** Hosts whose repositories this CI system can build and this adapter can fetch for. */
  readonly hosts: ReadonlySet<RepoHost>;
  listRunArtifacts(repo: CiRepo, runId: number): Promise<ReportArtifact[]>;
  /** Refuses a body over maxBytes with ArtifactRejectedError. */
  downloadArtifact(repo: CiRepo, artifactId: number, maxBytes: number): Promise<Uint8Array>;
}
```

`GithubActionsAdapter` (`ci/githubActions/GithubActionsAdapter.ts`) implements it over Octokit with
`hosts = {"github"}`, using the code now in `github/artifacts.ts`. It also owns the inbound side, as plain methods the
webhook route calls:

- `skipReason(event)`: today's `workflowRunSkipReason`, unchanged;
- `toRunInput(event, repo)`: maps a `workflow_run` payload to the neutral `CiRunInput` (below), taking owner and name
  from the registered repo, never the payload, as today.

Signature verification and the delivery-id dedupe stay in `routes/webhooks/github.ts`. They are part of GitHub's
webhook protocol, and the route stays at `/webhooks/github`.

A CI-only adapter (Jenkins, CircleCI) will need per-repository settings, such as a server URL and job name, that GitHub
Actions does not. That table comes with the first such adapter; nothing here presumes its shape.

### Registry and wiring

- `ci/registry.ts`: `CiSourceRegistry`, a map from `CiSource` to adapter with a `get(ciSource)` that throws on an
  unknown source.
- `plugins/ciSources.ts` replaces `plugins/github.ts` and decorates `fastify.ciSources`. It builds
  `GithubActionsAdapter` from `GITHUB_PAT`, which stays required at startup, so `lambda/secrets.ts` does not change.
- `buildApp({ ciSources })` replaces `buildApp({ github })`. Tests pass a registry holding a fake adapter, a plain
  object that implements `CiSourceAdapter`, instead of a fake Octokit cast to `GithubClient`.

### Ingestion

`ingest/processWorkflowRun.ts` becomes `ingest/processCiRun.ts`:

```ts
export interface CiRunInput {
  repo: CiRepo;
  ciSource: CiSource;
  runId: number;
  attempt: number;
  workflowName: string;
  headSha: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  htmlUrl: string | null;
}

export async function processCiRun(db: AnyDb, adapter: CiSourceAdapter, input: CiRunInput): Promise<void>;
```

The body is today's logic: upsert the run, skip when a report exists, take the first non-expired artifact, check its
size, download, extract, parse and insert under `webhook-artifact`. Before any of it, it throws when
`adapter.ciSource` differs from `input.ciSource` or `adapter.hosts` does not contain `input.repo.host`, so a run is
never fetched through the wrong system's credentials.

### Host and CI source in the database

| Table | Column | Rule |
|---|---|---|
| `repos` | `host text not null` | check `host in ('github')` |
| `workflow_runs` | `ci_source text not null` | check `ci_source in ('github_actions')` |

Identity changes with them:

| Constraint | Today | After |
|---|---|---|
| repo by external id | `repos_github_repo_id_unique` on `(github_repo_id)` | unique `(host, github_repo_id)` |
| repo by path | `repos_full_name_unique` on `(full_name)` | unique `(host, full_name)` |
| run | `workflow_runs_repo_id_github_run_id_github_run_attempt_unique` on `(repo_id, github_run_id, github_run_attempt)` | unique `(repo_id, ci_source, github_run_id, github_run_attempt)` |

The run key is what makes several CI systems per repository safe: Jenkins build 1234 and GitHub Actions run 1234 on
the same repository are different rows. Without it, the second would be a false duplicate, or a 400 for a SHA
mismatch.

How the values propagate:

- **Webhook:** the route loads the repo row (with `host`) and passes `ciSource: "github_actions"`; `processCiRun`
  writes `ci_source` on the run and uses it in the upsert target.
- **Upload (v1):** `findRepoByToken` returns the repo's `host`, so `request.repo` carries it. `ingestReport` takes a
  `ciSource`, and the v1 route passes `DEFAULT_CI_SOURCE[repo.host]`, which is `github_actions` for every repository
  today. `ingestReport` uses it both when inserting the run and when looking up an existing run, so idempotency becomes
  (repo, CI source, run id, attempt, report key). The v1 upload API gets no new header.
- **Upload (v2):** an optional `X-FH-CI-Source` header, defaulting to the same value; see [API v2](api-v2.md).
- **Reads:** exposing `host` and `ciSource` is part of API v2. v1 exposes neither.

An upload from the flakehunter-airflow DAG and a webhook delivery for the same GitHub Actions run both resolve to
`github_actions`, so the two paths still never count a run twice.

Flaky detection does not change. A test that passes on Jenkins and fails on GitHub Actions for the same SHA is flaky,
which is what "regardless of which workflow or job produced the results" already means.

**Naming.** The Drizzle properties become neutral while the database columns keep their names:

```ts
externalRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
runId: bigint("github_run_id", { mode: "number" }).notNull(),
runAttempt: integer("github_run_attempt").notNull().default(1),
```

Renaming the columns themselves waits for [Naming cleanup](#naming-cleanup). drizzle-kit asks interactively whether a
changed column is a rename or a drop-and-add, and a wrong answer on Neon drops data; property names give the same
code-level decoupling with no risk, so the column rename can be done separately and carefully.

The public API fields (`githubRunId` in history and failure responses, `X-FH-Run-Id`) do not change, so
`docs/openapi.json` is untouched and `openapi:check` stays green. The query modules map `runId` back to `githubRunId`
in their output.

### Migration

`0003_host_and_ci_source.sql`, generated with `bun run db:generate` from the `schema.ts` change and reviewed by hand:

1. `ALTER TABLE repos ADD COLUMN host text NOT NULL DEFAULT 'github'`, then `DROP DEFAULT`, plus the check constraint.
2. `ALTER TABLE workflow_runs ADD COLUMN ci_source text NOT NULL DEFAULT 'github_actions'`, then `DROP DEFAULT`, plus
   the check constraint.
3. Replace the three unique constraints as in the table above.

The defaults exist only to fill existing rows; Postgres does that without rewriting the tables. Dropping them
afterwards means every insert has to name the host or CI source, so a write path that forgets fails in tests instead
of silently recording `github`. You run `bun run db:migrate` against Neon; the agent does not.

## Steps

Each step leaves `bun run lint && bun run typecheck && bun run test` green and is one commit.

1. **Adapter, no schema change.** Add `ci/types.ts`, `ci/registry.ts` and `ci/githubActions/` (moving `client.ts`,
   `artifacts.ts`, `runSource.ts` and `webhookVerify.ts` there). Add `GithubActionsAdapter`, `plugins/ciSources.ts`
   and `processCiRun`; switch the webhook route and `buildApp` over; remove `plugins/github.ts` and
   `processWorkflowRun.ts`. Until step 2, `CiRepo.host` and `CiRunInput.ciSource` are filled with the constants.
   Move the tests onto a fake adapter, and add `GithubActionsAdapter` tests over a fake Octokit (what
   `processWorkflowRun.test.ts` covers today at the Octokit level).
2. **Host and CI source in the database.** `RepoHost`, `CiSource` and `DEFAULT_CI_SOURCE` in shared-types; `host` on
   `Repo` and `ciSource` on `WorkflowRun` in `domain.ts`; the schema change, property renames and migration;
   `findRepoByToken` returns `host`; `ingestReport` and `processCiRun` write and match on `ci_source`; `resolveRepo`
   matches `full_name` within a host and reports an ambiguous path (two hosts, same path) as a 400 rather than picking
   one; `test/fixtures.ts` seeds both. Scripts:
   - `seed-dev-repo.ts` takes `SEED_REPO_HOST` (default `github`) and `SEED_REPO_EXTERNAL_ID`, still accepting
     `SEED_REPO_GITHUB_ID`, and only writes `github_installations` for `github`;
   - `create-repo-token.ts` takes `TOKEN_REPO_HOST` (default `github`) with `TOKEN_REPO_FULL_NAME`.
3. **Docs.** ADR 0011 "Repository hosts and CI sources"; the architecture section of `CLAUDE.md` (ingestion path,
   decorators, test faking, seeding and token commands). GitLab's `gitlab` host and `gitlab_ci` CI source are added
   later, in their own change, as flakehunter-airflow's GitLab ingest brief describes.
4. **Naming cleanup.** See below. It can start once step 2 has landed; its last part waits for API v2.

## Naming cleanup

After steps 1–3, GitLab data reaches FlakeHunter through `POST /api/reports` (pulled and uploaded by Airflow) and
touches no GitHub-named code, but it is still stored and returned under GitHub names. This step removes those names.
GitLab data never goes through the adapter itself; the adapter only matters for a future GitLab webhook.

1. **Rename the columns.** `repos.github_repo_id` → `external_repo_id`, `workflow_runs.github_run_id` →
   `ci_run_id`, `workflow_runs.github_run_attempt` → `run_attempt`, with the constraints and indexes that name them.
   Write the migration by hand (`bunx drizzle-kit generate --custom --name=rename_ci_columns`) as
   `ALTER TABLE … RENAME COLUMN`, which keeps the data and is metadata-only. Change the column names in `schema.ts` to
   match, then run `bun run db:generate` in a terminal: it must report no changes. If it offers a drop-and-add, the
   snapshot is out of step; fix that before committing. You run `bun run db:migrate` on a Neon branch first, then
   production.
2. **Fix comments that say GitHub on the shared path.** `ingest/limits.ts` (the artifact limit is per CI download,
   not "downloaded from GitHub") and the `WEBHOOK_REPORT_KEY` comment. The value `webhook-artifact` stays: it is what
   keeps an upload and a webhook delivery of the same run from counting twice.
3. **Accept nested repository paths.** The `repo` query parameter accepts `owner/name` only, which rejects
   `group/sub/project`. The API side ships in [API v2](api-v2.md), step 2; this step makes `TOKEN_REPO_FULL_NAME` in
   `scripts/create-repo-token.ts` follow the same rule.
4. **Retire API v1.** Once the web app, `packages/mcp-server` and the Airflow DAG are on `/api/v2`
   ([API v2](api-v2.md), step 4), remove the `/api` mounts, the v1 mappers and `docs/openapi.json`, and with them the
   last `githubRunId`.

In the flakehunter-airflow repo, as part of its GitLab work rather than here: move `download_artifact` out of
`github.py` into a shared module (already in that repo's `gitlab-ingest.md`), and reword the `RunHeaders` docstring
in `client.py`, which says the values come from the GitHub `workflow_run`.

Validation for this step: `bun run lint && bun run typecheck && bun run test`; `createTestDb()` applies the rename
migration; a test that a repo with a nested `full_name` resolves through `repo=`; `bun run db:generate` reports no
changes after the rename; and, after v1 is removed, `grep -ri github` over `apps/api/src` outside `ci/githubActions/`,
`routes/webhooks/` and the migrations finds nothing.

## Not touched

- The upload API, its headers and `docs/openapi.json`; the read endpoints' response shapes.
- `apps/web`, `packages/mcp-server`, `infra/`.
- The `flaky_tests` view and `flaky/` queries.
- `github_installations` and `webhook_events`, which stay GitHub webhook tables.
- Database column names (`github_repo_id`, `github_run_id`, `github_run_attempt`) in steps 1–3; they are renamed in
  step 4.
- A GitLab adapter, a GitLab webhook, CI-only adapters and per-repository CI settings.

## Risks

- **Constraint swaps on production.** Between dropping and recreating each unique constraint, nothing stops a
  duplicate. All statements run in the migration's transaction, so the window is not observable. Widening a unique
  key cannot fail on existing data: every set of rows unique on the old key is unique on the new one.
- **A write path that forgets `ci_source`.** Covered by dropping the column defaults: such an insert fails with a
  not-null violation in tests.
- **Ambiguous repo paths.** Once a second host exists, `owner/name` can match two repositories. `resolveRepo` refuses
  to guess; v2 adds a host-qualified form (see [API v2](api-v2.md)). With only `github` today, nothing is ambiguous.
- **Test rewrite hides a behaviour change.** Moving `processWorkflowRun.test.ts` from a fake Octokit to a fake adapter
  could drop a case. Step 1 keeps every existing case, split between `processCiRun.test.ts` (ingestion logic) and
  `GithubActionsAdapter.test.ts` (Octokit calls, binary check, size check).
- **Lambda bundle.** esbuild must still see every module; there is no runtime import from disk, and `synth:infra`
  in CI catches a broken bundle.

## Validation

- `bun run lint`, `bun run typecheck`, `bun run test` (which includes `openapi:check`) after each step; `synth:infra`
  in CI.
- New tests:
  - the registry rejects an unknown CI source;
  - `processCiRun` refuses an adapter whose CI source differs from the run's, or whose hosts exclude the repo's;
  - `findRepoByToken` returns the repo's `host`;
  - the webhook and a v1 upload both write `ci_source = 'github_actions'`, and an upload after a webhook delivery of the
    same run is still a `200` duplicate;
  - two runs with the same run id and attempt but different CI sources are separate rows;
  - the migration applied by `createTestDb()` fills existing-style rows, rejects values outside the checks, rejects an
    insert without `host` or `ci_source`, and enforces the three new unique keys;
  - `resolveRepo` returns a 400 for a path that matches repositories on two hosts.

  Only `github` and `github_actions` pass the check constraints today, so the two multi-value tests widen the
  constraint in their own PGlite database first.
- Manual: `bun run db:migrate` on a Neon branch, then one webhook delivery and one upload against `bun run dev:api`.
