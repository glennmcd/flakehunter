# FlakeHunter API

How CI sends test reports to FlakeHunter, and the read endpoints the dashboard and the MCP server use. To run the API
itself, see [deployment.md](deployment.md).

The commands below are bash commands, run from the repository root (on Windows, use Git Bash).

## Uploading reports from CI

Instead of (or as well as) the webhook, CI can push a JUnit XML report straight to
`POST /api/reports`. It authenticates with a per-repo upload token, so a leaked CI secret can only
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
    gzip -c junit.xml | curl --fail-with-body -X POST "$FLAKEHUNTER_URL/api/reports" \
      -H "Authorization: Bearer $FLAKEHUNTER_TOKEN" \
      -H "Content-Type: application/xml" \
      -H "Content-Encoding: gzip" \
      -H "X-FH-Run-Id: ${{ github.run_id }}" \
      -H "X-FH-Run-Attempt: ${{ github.run_attempt }}" \
      -H "X-FH-Sha: ${{ github.event.pull_request.head.sha || github.sha }}" \
      -H "X-FH-Branch: ${{ github.head_ref || github.ref_name }}" \
      -H "X-FH-Workflow: ${{ github.workflow }}" \
      --data-binary @-
  env:
    FLAKEHUNTER_URL: https://your-flakehunter-host
    FLAKEHUNTER_TOKEN: ${{ secrets.FLAKEHUNTER_TOKEN }}
```

Use the PR head SHA (as above), not the merge commit, so uploads line up with webhook data.

| Header | Required | Meaning |
| --- | --- | --- |
| `X-FH-Run-Id` | yes | CI run id; with the attempt and report key it makes the upload idempotent |
| `X-FH-Sha` | yes | 40-character commit SHA the tests ran against |
| `X-FH-Run-Attempt` | no (1) | A re-run is a new attempt, which is what lets a flake show up on one commit |
| `X-FH-Branch`, `X-FH-Workflow` | no | Stored on the run |
| `X-FH-Report-Key` | no (`default`) | Distinguishes several reports for one run (e.g. `unit`, `integration`) |
| `X-FH-Timestamp` | no (now) | When the tests ran, ISO-8601 (not more than 5 minutes in the future). Stamps a new run and its results; use it for late uploads or seeded history |

Re-uploading the same run, attempt and report key is a no-op and returns `200` with the original
counts; a first upload returns `201`.

**Body size.** The XML may be up to 11 MB, measured after decompression. Send it gzip-compressed with
`Content-Encoding: gzip` (as above; reports shrink about tenfold). This matters when the API runs behind AWS
Lambda, which rejects any request body over about 6 MB (about 4.5 MB of raw data after base64), so an uncompressed
report above that size never reaches the API. `gzip` is the only encoding accepted; others get a `400`, and gzip
data that expands past 11 MB gets a `413`.

**Rate limit.** Uploads are limited per source IP and per token (default 120 a minute). Past the limit the API
answers `429` with a `Retry-After` header.

## Read endpoints

Read endpoints use the global `API_TOKEN` as the bearer token. `repo` is a numeric id or
`owner/name`; `since` is an ISO-8601 timestamp (default: 30 days ago). List endpoints take
`limit` (default 50, max 200) and `offset`, and return `{ data, page: { limit, offset, total } }`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/repos` | Registered repos (`id`, `fullName`, `owner`, `name`), ordered by name |
| `GET /api/tests/flaky?repo=&since=&minRuns=` | Tests ranked by flake rate: commits where the test both passed and failed, divided by commits it ran on (skipped ignored; `minRuns` defaults to 5) |
| `GET /api/tests/:id/history?since=&status=` | Newest-first results for one test, with run details |
| `GET /api/tests/:id/failures` | The 50 most recent failed or errored results for one test, newest first, with failure message and run details (not paginated) |
| `GET /api/repos/:id/summary?since=` | Totals for the dashboard: runs, tests, results, pass rate, flaky tests and flaky commits |

## Errors

Every `/api` error has the same shape:

```json
{ "error": { "code": "validation_error", "message": "...", "details": [{ "path": "querystring.limit", "message": "..." }] }, "requestId": "req-1" }
```

Codes: `validation_error` (400), `unauthorized` (401), `not_found` (404), `payload_too_large` (413),
`invalid_report` (422), `rate_limited` (429, with `Retry-After`), `internal_error` (500). `details` appears only on validation errors.
