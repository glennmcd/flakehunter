# GitLab ingest

**Status:** Draft, for review. No code changes until this is agreed.

This brief extends `flakehunter_ingest` to GitLab CI. A second discovery path lists finished GitLab pipelines, collects
the JUnit XML from their jobs and uploads it through the same `POST /api/reports` path the GitHub DAG uses. The upload
client, zip extraction, JUnit merge and size limits are reused unchanged. What is new: a run model shared by both
providers, a GitLab adapter, a rule for the run attempt, a trust check and the configuration.

It depends on one FlakeHunter change, described first, because without it a GitLab project cannot be registered.

## Prerequisite: FlakeHunter repository identity

FlakeHunter keys repositories on GitHub's numeric repo id (`repos.github_repo_id`, unique, per
[ADR 0003](https://github.com/glennmcd/flakehunter/blob/main/docs/decisions/0003-multi-repo-schema.md)). A GitLab
project id lives in a different number space and can collide with a GitHub repo id. The read API also accepts
`repo` as "owner/name or a numeric id", which does not fit nested GitLab paths such as `group/sub/project`.

FlakeHunter needs, in its own ADR and release:

- a provider column on `repos`, with uniqueness on (provider, external repo id);
- a display name that allows nested paths, and a way for the read API to address it;
- a registration path (seed script or admin endpoint) that issues an upload token for a GitLab project.

The upload endpoint itself needs no change. The repository comes from the upload token, and runs are keyed on
(repo, run id, attempt), so GitLab pipeline ids cannot collide with GitHub run ids. The header and field names
(`githubRunId`) stay as they are; renaming them would break the published contract for no functional gain.

If the read API changes, this repo re-pins `contract/openapi.json` in the usual way.

## Shape

```text
discover_pipelines  ──►  upload_pipeline.expand(pipeline)  ──►  summarize
```

A separate DAG, `flakehunter_ingest_gitlab`, with the same schedule, lookback and `flakehunter_upload` pool as the
GitHub DAG. A separate DAG keeps the two providers' connections, failures and backfills apart while sharing all the
upload code.

- **`discover_pipelines`** calls `GET /projects/:id/pipelines?updated_after=…` for each configured project and keeps
  pipelines in a terminal state (`success`, `failed`, `canceled`). Running pipelines are picked up on a later run.
  It applies [Trust](#trust) and returns one descriptor per pipeline.
- **`upload_pipeline`** lists the pipeline's jobs, downloads the artifact of every current (non-retried) job that has
  one, extracts the `.xml` files, merges them into one `<testsuites>` document and uploads it.
- **`summarize`** works as in the GitHub DAG.

## Headers and the run attempt

| Header | Source |
|---|---|
| `X-FH-Run-Id` | `pipeline.id` |
| `X-FH-Run-Attempt` | 1 + number of retried jobs in the pipeline (see below) |
| `X-FH-Sha` | `pipeline.sha` |
| `X-FH-Branch` | `pipeline.ref` |
| `X-FH-Workflow` | `pipeline.name` when set, otherwise omitted |
| `X-FH-Timestamp` | `pipeline.started_at` (single-pipeline endpoint) |
| `X-FH-Report-Key` | `webhook-artifact`, always |

GitLab has no pipeline-level attempt. Retrying a job keeps the pipeline id and adds a new job, marking the old one
`retried`. If the attempt were always `1`, the first upload would win and every later retry would return `200`
duplicate, losing exactly the same-SHA reruns flaky detection depends on.

The attempt is therefore derived from GitLab's own data: `1 + count(jobs where retried = true)`, from
`GET /projects/:id/pipelines/:id/jobs?include_retried=true`. It is the same on every poll of a finished pipeline,
grows by one with every job retry, and uses nothing from Airflow, so the idempotency rule in `CLAUDE.md` holds. Each
new attempt uploads the results of the current jobs, which is the GitLab equivalent of GitHub's "latest attempt".

Results of the retried jobs themselves are not uploaded, as with earlier GitHub attempts. GitLab does keep them, so
this could be added later as a separate attempt per retry; it is out of scope here.

## Artifacts

GitLab stores artifacts per job. The DAG downloads each job's archive with `GET /projects/:id/jobs/:job_id/artifacts`
and merges the XML across jobs, applying the 10 MiB limit per archive and the 11 MiB limit to the merged document.

Projects must publish their JUnit files in the job archive, that is under `artifacts:paths` and not only under
`artifacts:reports:junit`. Whether reports-only JUnit files can be downloaded through the API needs checking (see
[Open questions](#open-questions)). GitLab's parsed `test_report` JSON endpoint is not used: converting it back to XML
would lose detail that FlakeHunter parses.

## Trust

Mirroring the GitHub filter, a pipeline is uploaded only when:

- `pipeline.source` is one of `push`, `merge_request_event`, `schedule` or `web`;
- for `merge_request_event`, the merge request's `source_project_id` equals its `target_project_id`. The merge request
  iid is parsed from `ref` (`refs/merge-requests/<iid>/head`) and fetched with one extra call.

Other sources (`api`, `trigger`, `pipeline`, `parent_pipeline`, `external`, `chat`, …) are counted as skipped.
Fork merge request pipelines that a maintainer runs in the parent project are skipped too: the fork author still
controls the code that produced the artifact.

## Configuration

| Item | Kind | Contents |
|---|---|---|
| `flakehunter_gitlab_projects` | Variable (JSON) | list of numeric GitLab project ids |
| `gitlab_default` | Connection | host = GitLab base URL (gitlab.com or self-hosted), password = token with `read_api` |
| `flakehunter_upload_gitlab_<project_id>` | HTTP Connection | host = FlakeHunter base URL, password = that project's upload token |

Numeric project ids avoid the URL-encoding and nested-path problems of `group/sub/project`, and survive project
renames and transfers. The existing `flakehunter_repos` Variable and GitHub connections are untouched. One GitLab host
per deployment is supported.

## Code changes

- `src/flakehunter_ingest/run.py`: a provider-neutral `CiRun` (run id, attempt, sha, branch, workflow, started at,
  upload connection id) with a `headers()` method that builds `RunHeaders`.
- `src/flakehunter_ingest/gitlab.py`: HTTP client, pipeline and job listing, attempt derivation, artifact download.
  `download_artifact` moves to a shared module so both providers use the same size-limited stream.
- `src/flakehunter_ingest/trust.py`: a `is_pipeline_trusted` next to the existing check.
- `src/flakehunter_ingest/processrun.py`: split so the "XML files → merge → upload" step takes a `CiRun` and a list
  of zip bytes, independent of the provider. The GitHub path is moved onto it with no change in behaviour.
- `dags/flakehunter_gitlab_dag.py`: the new DAG.
- `scripts/get_gitlab_fixture.py`: records pipeline, job and artifact fixtures from a real project, like the GitHub
  scripts.

`client.py`, `junit.py`, `safezip.py`, `limits.py` and the generated `_api/` do not change.

## Validation

- **Unit tests** (`respx`, recorded fixtures): header mapping from a pipeline payload; attempt derivation with no
  retries, one retry and retries across several jobs; skipping non-terminal pipelines; trust for each source and for
  same-project and fork merge requests; merging XML from several jobs; size limits.
- **Regression:** the existing GitHub tests pass unchanged after the `processrun` split.
- **End to end:** in the dev container, `airflow dags test flakehunter_ingest_gitlab` against a local FlakeHunter
  and a gitlab.com test project. Run the interval twice and expect `201`s then duplicates. Retry one job, run again
  and expect one new `201` for attempt 2 on the same SHA.

## Open questions

1. Can JUnit files declared only under `artifacts:reports:junit` be downloaded through the jobs API? If yes, the
   "also list them under `artifacts:paths`" requirement goes away.
2. Merged-results pipelines test a merge commit, so `pipeline.sha` is not a commit on the branch. Should those
   pipelines be uploaded, skipped, or tagged by branch?
3. Child pipelines (`parent_pipeline` source) often hold the test jobs in monorepos. Are they needed in the first
   version? Including them means walking bridge jobs and deciding which pipeline id the report belongs to.
4. Which FlakeHunter release adds GitLab repository registration, and does it change the read API?

## Not in scope

- Results of retried jobs as separate attempts.
- More than one GitLab host per deployment.
- A GitLab webhook in FlakeHunter.
- Changes to the upload API or its header names.
