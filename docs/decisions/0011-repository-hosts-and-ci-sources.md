# 0011: Repository hosts and CI sources

**Status:** Accepted ([CI source adapters](../plans/ci-source-adapters.md))

## Context

Everything was GitHub: repos were keyed on GitHub's repo id and runs on GitHub's run id, and ingestion called Octokit
directly. GitLab is next, and a repository's code host and its CI system are not the same thing: a GitHub repo can be
built by GitHub Actions, Jenkins, or both.

## Decision

Record the two separately. `repos.host` (`github`) says where the code lives; `workflow_runs.ci_source`
(`github_actions`) says which system ran a run. The repo keys are `(host, github_repo_id)` and `(host, full_name)`,
and the run key is `(repo_id, ci_source, github_run_id, github_run_attempt)`. CI-specific fetching sits behind
`CiSourceAdapter` (`ci/`), with `GithubActionsAdapter` the only one. Hosts get no adapter until something needs one.
The v1 API cannot name a CI source and uses `DEFAULT_CI_SOURCE[host]`; exposing host and CI source is v2's job.

## Consequences

- Two CI systems can report the same run number on one repo without colliding, and an upload and a webhook delivery
  of one GitHub Actions run still count once.
- A bare `owner/name` matching repos on two hosts is a 400 rather than a guess.
- Each new host or CI source is added to `REPO_HOSTS` / `CI_SOURCES` and to the check constraint in one change.
- Column names still say `github_*` until the naming cleanup renames them (`docs/plans/ci-source-adapters.md`).
