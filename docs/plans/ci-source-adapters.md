# CI source adapters

**Status:** Implemented in [#15](https://github.com/glennmcd/flakehunter/pull/15); API v1 has since been retired. The
decision is [ADR 0011](../decisions/0011-repository-hosts-and-ci-sources.md);
`CLAUDE.md` ("Ingestion path") is the day-to-day reference.

FlakeHunter keeps two things apart that were one while everything was GitHub:

- **Host:** where a repository's code lives and what identifies it (`github`, later `gitlab`, `bitbucket`, …). Stored
  as `repos.host`.
- **CI source:** the system that ran a workflow and holds its artifacts (`github_actions`, later `gitlab_ci`,
  `jenkins`, `circleci`, …). Stored per run as `workflow_runs.ci_source`.

A GitHub repository can be built by GitHub Actions, by Jenkins, or by both, so a repository has one host and its runs
can come from several CI sources. CI-specific fetching sits behind a `CiSourceAdapter` interface, with
`GithubActionsAdapter` as the only implementation.

Hosts are `github` and `gitlab`, and CI sources `github_actions` and `gitlab_ci` ([gitlab-values.md](gitlab-values.md)); `gitlab_ci` runs arrive only through uploads, with no adapter. The host and CI source are exposed in
[API v2](api-v2.md). This is the groundwork for GitLab (flakehunter-airflow's
[GitLab ingest](https://github.com/glennmcd/flakehunter-airflow/blob/main/docs/plans/gitlab-ingest.md)) and for CI-only
systems.

Neither term is the ingestion channel (webhook or upload); that is carried by `reports.report_key`.

## Where the code lives

All paths are under `apps/api/src/` unless noted.

| Area | Files | Notes |
|---|---|---|
| Types | `packages/shared-types/src/domain.ts` | `REPO_HOSTS`, `CI_SOURCES`, `DEFAULT_CI_SOURCE`; `Repo` and `WorkflowRun` use the neutral `externalRepoId`, `ciRunId`, `runAttempt` |
| Adapter interface | `ci/types.ts` | `CiRepo`, `ReportArtifact`, `CiSourceAdapter` |
| Registry | `ci/registry.ts`, `plugins/ciSources.ts`, `app.ts` | `fastify.ciSources`; `buildApp({ ciSources })` |
| GitHub Actions | `ci/githubActions/` | `GithubActionsAdapter.ts`, `client.ts` (Octokit), `artifacts.ts`, `runSource.ts` (trust), `webhookVerify.ts`, `workflowRun.ts` |
| Webhook | `routes/webhooks/github.ts` | signature, delivery-id dedupe, repo lookup, `processCiRun` |
| Ingestion | `ingest/processCiRun.ts`, `ingest/ingestReport.ts` | webhook path and upload path, both keyed on the CI source |
| Repo identity | `db/schema.ts`, `api/resolveRepo.ts`, `auth/repoToken.ts` | unique `(host, external_repo_id)` and `(host, full_name)`; `findRepoByToken` returns `host` |
| Run identity | `db/schema.ts` | `workflow_runs_run_key_unique` on `(repo_id, ci_source, ci_run_id, run_attempt)` |
| Queries | `history/testHistoryQueries.ts`, `history/testFailuresQueries.ts` | select `ciRunId` and `ciSource` and return the v2 shape |
| Scripts | `scripts/seed-dev-repo.ts`, `scripts/create-repo-token.ts` | `SEED_REPO_HOST`, `TOKEN_REPO_HOST` (default `github`) |
| Test helpers | `apps/api/test/fixtures.ts` | `seedRepo({ host })`, `seedRun({ ciSource })`, `runIdentity(apiVersion, …)` |

The `github/` folder and `plugins/github.ts` no longer exist; `processWorkflowRun.ts` became `processCiRun.ts`.

## Design

### Types

```ts
// packages/shared-types/src/domain.ts
export const REPO_HOSTS = ["github", "gitlab"] as const;
export type RepoHost = (typeof REPO_HOSTS)[number];

export const CI_SOURCES = ["github_actions", "gitlab_ci"] as const;
export type CiSource = (typeof CI_SOURCES)[number];

export const DEFAULT_CI_SOURCE: Readonly<Record<RepoHost, CiSource>> = {
  github: "github_actions",
  gitlab: "gitlab_ci",
};
```

The arrays feed the Drizzle column enums in `db/schema.ts` and the scripts' input checks. Each new value is added here
and in the matching database check constraint, in one change.

Hosts get no adapter class: FlakeHunter never calls a host's API for anything but CI data. A host adapter (commit
links, repository metadata) can be added when something needs it.

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
  /** Downloads an artifact zip, refusing a body over `maxBytes` with ArtifactRejectedError. */
  downloadArtifact(repo: CiRepo, artifactId: number, maxBytes: number): Promise<Uint8Array>;
}
```

`ci/types.ts` also re-exports `REPO_HOSTS`, `RepoHost` and `CiSource` for the root scripts, which cannot resolve
workspace packages themselves.

`GithubActionsAdapter` implements the interface over Octokit with `hosts = {"github"}`, using `artifacts.ts`. The
inbound side lives next to it in `ci/githubActions/` as plain functions the webhook route calls, so the adapter (and
every fake of it in tests) covers only fetching:

- `workflowRunSkipReason(event)` in `runSource.ts`: the trigger allow-list and fork check;
- `workflowRunToInput(event, repo)` in `workflowRun.ts`: maps a `workflow_run` payload to a `CiRunInput` with
  `ciSource: "github_actions"`, taking owner and name from the registered repo, never the payload.

Signature verification and the delivery-id dedupe stay in `routes/webhooks/github.ts`. They are part of GitHub's
webhook protocol, and the route stays at `/webhooks/github`.

A CI-only adapter (Jenkins, CircleCI) will need per-repository settings, such as a server URL and job name, that GitHub
Actions does not. That table comes with the first such adapter.

### Registry and wiring

- `ci/registry.ts`: `CiSourceRegistry`, built from a list of adapters. The constructor refuses two adapters for one CI
  source; `get(ciSource)` throws on an unknown one.
- `plugins/ciSources.ts` decorates `fastify.ciSources`. Without a registry in its options it builds
  `GithubActionsAdapter` from `GITHUB_PAT`, which stays required at startup, so `lambda/secrets.ts` is unchanged.
- `buildApp({ ciSources })` passes a registry through. Tests give it a registry holding a fake adapter, a plain object
  that implements `CiSourceAdapter`.

### Ingestion

```ts
// apps/api/src/ingest/processCiRun.ts
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

Before touching the database, `processCiRun` throws when `adapter.ciSource` differs from `input.ciSource` or
`adapter.hosts` does not contain `input.repo.host`, so a run is never fetched through the wrong system's credentials.
It then upserts the run on `workflow_runs_run_key_unique`, skips when a report exists, takes the first non-expired
artifact, checks its size, downloads, extracts, parses and inserts under `WEBHOOK_REPORT_KEY` (`webhook-artifact`).

The webhook route looks the repo up by `(host = 'github', external_repo_id)`, builds the `CiRepo` from that row and
calls `processCiRun` with `fastify.ciSources.get("github_actions")`.

### Host and CI source in the database

| Table | Column | Rule |
|---|---|---|
| `repos` | `host text not null` | `repos_host_check`: `host in REPO_HOSTS` |
| `repos` | `external_repo_id bigint not null` | the host's own repository id |
| `workflow_runs` | `ci_source text not null` | `workflow_runs_ci_source_check`: `ci_source in CI_SOURCES` |
| `workflow_runs` | `ci_run_id bigint not null`, `run_attempt integer not null default 1` | the CI system's run id and attempt |

| Key | Columns |
|---|---|
| `repos_host_external_repo_id_unique` | `(host, external_repo_id)` |
| `repos_host_full_name_unique` | `(host, full_name)` |
| `workflow_runs_run_key_unique` | `(repo_id, ci_source, ci_run_id, run_attempt)` |

The run key is named explicitly: drizzle-kit's generated name for it was 71 characters, which Postgres would cut to 63.
It is what makes several CI systems per repository safe: Jenkins build 1234 and GitHub Actions run 1234 on the same
repository are different rows. Neither `host` nor `ci_source` has a default, so every insert names them.

Drizzle properties match the columns: `externalRepoId`, `ciSource`, `ciRunId`, `runAttempt`.

How the values propagate:

- **Webhook:** `processCiRun` writes `ci_source` from `CiRunInput` and uses it in the upsert target.
- **Upload:** `findRepoByToken` returns `{ id, host, fullName }`. `routes/api/reports.ts` passes
  `ciSource: X-FH-CI-Source ?? DEFAULT_CI_SOURCE[repo.host]` to `ingestReport`. `ingestReport`
  uses the CI source both when inserting the run and when looking up an existing one, so idempotency is (repo, CI
  source, run id, attempt, report key). An upload without the header and one naming `github_actions` are the same run.
- **Reads:** the query modules and `ingestReport` return the v2 shape (`run.ciRunId`, `run.ciSource`, repo `host`),
  which the routes send as is.

An upload from the flakehunter-airflow DAG and a webhook delivery for the same GitHub Actions run both resolve to
`github_actions`, so the two paths never count a run twice.

Flaky detection does not change. A test that passes on Jenkins and fails on GitHub Actions for the same SHA is flaky,
which is what "regardless of which workflow or job produced the results" already means.

`resolveRepo` matches `full_name` within a host when one is given (`github:acme/widgets`). A bare path that
matches repositories on more than one host is a 400 naming the hosts. Paths
can be nested (`group/sub/project`), in the API and in `TOKEN_REPO_FULL_NAME`.

### Migrations

- `0003_host_and_ci_source.sql`, generated and edited by hand: adds `host` and `ci_source` with defaults that fill
  existing rows (`github`, `github_actions`) and drops the defaults straight after; replaces the three unique
  constraints with the host- and CI-source-scoped ones; adds the two check constraints.
- `0004_rename_ci_columns.sql`, hand-written: `RENAME COLUMN` from `github_repo_id`, `github_run_id` and
  `github_run_attempt` to `external_repo_id`, `ci_run_id` and `run_attempt`, and renames the repo key to
  `repos_host_external_repo_id_unique`. A rename keeps the data and only changes the catalog. A column rename is always
  written this way, never by `db:generate`, which may offer a drop-and-add; afterwards `db:generate` reports no changes.
- `0006_gitlab_values.sql`, generated: widens both check constraints to the GitLab values. The constraints are built
  from `REPO_HOSTS` and `CI_SOURCES` in `db/schema.ts`, so adding a value and running `db:generate` is the whole change.

## Remaining work

1. **GitLab values:** done ([gitlab-values.md](gitlab-values.md)); spec 2.1.0. flakehunter-airflow re-pins to the
   release that carries it before its GitLab DAG lands.
2. **flakehunter-airflow**, as part of its GitLab work: `download_artifact` has moved to its `shared` package; the
   `RunHeaders` docstring in `shared/client.py`, which says the values come from the GitHub `workflow_run`, is reworded
   with the re-pin.

With v1 retired ([ADR 0012](../decisions/0012-api-v2-alongside-v1.md)), `grep -ri github` over `apps/api/src`
outside `ci/githubActions/`, `routes/webhooks/`, the migrations and tests finds only the webhook's wiring (its
registration in `routes/index.ts`, its auth exemption in `plugins/auth.ts`, `github_installations`), the GitHub adapter
in `plugins/ciSources.ts`, the GitHub secrets (`GITHUB_PAT`, `GITHUB_WEBHOOK_SECRET`) in `app.ts`, `lambda/secrets.ts`
and `openapi/buildSpec.ts`, and `github` or `github_actions` as values and in examples.

## Still GitHub-specific by design

- `github_installations` and `webhook_events`: the GitHub webhook's own tables. `seed-dev-repo.ts` writes
  `github_installations` only for `github`.
- `packages/shared-types/src/github.ts`: the `workflow_run` payload type.
- `/webhooks/github`, `GITHUB_PAT` and `GITHUB_WEBHOOK_SECRET`.

## Tests

| What | Where |
|---|---|
| Registry: lookup, unknown CI source, duplicate adapter | `ci/registry.test.ts` |
| Plugin: given registry, adapter from `GITHUB_PAT`, refuses to start without it | `plugins/ciSources.test.ts` |
| Adapter: CI source and hosts, listing, download, size and binary checks | `ci/githubActions/GithubActionsAdapter.test.ts` |
| Payload mapping | `ci/githubActions/workflowRun.test.ts` |
| Adapter guards, idempotency, artifact limits | `ingest/processCiRun.test.ts` |
| Webhook writes `ci_source = 'github_actions'` | `routes/webhooks/github.test.ts` |
| Uploads write the CI source, with and without `X-FH-CI-Source` | `routes/api/reports.test.ts` |
| An upload without the header and one naming `github_actions` are one run | `api/versions.test.ts` |
| `findRepoByToken` returns the host | `auth/repoToken.test.ts` |
| Migration 0003: fills old rows, no defaults, check constraints, new keys; 0004: keeps rows and keys; 0006: every listed value passes, others fail | `db/schema.test.ts` |
| Nested paths, a bare path on two hosts is a 400, a host-qualified path resolves | `api/resolveRepo.test.ts` |

The multi-host and multi-source tests use the real `gitlab` and `gitlab_ci` values; uploads for a `gitlab`
repository and a `gitlab_ci` run beside a `github_actions` one with the same id are in `api/versions.test.ts`.
