# FlakeHunter

Ingests JUnit XML test reports from GitHub Actions, stores results in Postgres, and flags a
test as flaky when it has both a pass and a fail result on the same commit SHA — regardless of
which workflow or job produced the result.

Stack: Fastify API (`apps/api`), React dashboard (`apps/dashboard`), Postgres (Neon for
dev/prod, PGlite for tests). See `.claude/plans` (or ask for a copy) for the full week-1 design.

## Setup

1. Install dependencies:
   ```
   bun install
   ```
2. Create `apps/api/.env` (copy `.env.example`) with:
   - `DATABASE_URL` — a Postgres connection string (Neon free tier works well; no local Postgres
     needed)
   - `API_TOKEN` — any string; this is the bearer token the dashboard and API clients must send
   - `GITHUB_WEBHOOK_SECRET` — any string; must match the secret configured on the GitHub webhook
   - `GITHUB_PAT` — a classic GitHub PAT with `repo` + `workflow` scopes, used to list/download
     workflow run artifacts
3. Run migrations:
   ```
   bun run db:migrate
   ```
4. Start the API:
   ```
   bun run dev:api
   ```
5. Start the dashboard (separate terminal): copy `apps/dashboard/.env.example` to
   `apps/dashboard/.env` (`VITE_API_TOKEN` must match `API_TOKEN` above), then:
   ```
   bun run dev:dashboard
   ```

## Web dashboard (`apps/web`)

A Next.js app (App Router) that reads from the API server-side, so the API token never reaches the
browser. It is being built up over several changes; today it is a scaffold with typed config.

1. Copy `apps/web/.env.example` to `apps/web/.env.local` and set:
   - `API_BASE_URL`: where the API runs (default `http://localhost:3000`)
   - `API_TOKEN`: the API's read token (the same value as `API_TOKEN` in `apps/api/.env`)
   - `SITE_PASSWORD`: password for the site-wide gate; leave empty to disable it locally
2. With the API running, start it:
   ```
   bun run dev:web
   ```
   It serves on <http://localhost:3001> (the API uses 3000), so the demo repo is at
   <http://localhost:3001/repos/3>.

**Site password.** When `SITE_PASSWORD` is set, every page and asset is behind HTTP Basic auth: the
browser prompts once, and you can enter any username with the password. When it is unset the site
is open in development, but a production build **refuses to serve (503)** rather than going public
by accident. Basic auth sends the password with every request, so only expose the site over HTTPS
(Vercel does this for you).

`bun run build:web` makes a production build (CI runs it). The older Vite dashboard in
`apps/dashboard` still exists and is untouched.

## Registering a repo

FlakeHunter needs a `repos` row before it will ingest anything from a given GitHub repo. Seed one
with:

```
SEED_REPO_OWNER=<owner> SEED_REPO_NAME=<repo> SEED_REPO_GITHUB_ID=<github numeric repo id> \
  bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
```

Get the numeric GitHub repo id with `gh api repos/<owner>/<repo> --jq '.id'`.

## Uploading reports from CI (v1 API)

Instead of (or as well as) the webhook, CI can push a JUnit XML report straight to
`POST /api/reports`. It authenticates with a per-repo upload token, so a leaked CI secret can only
write to its own repo.

Mint a token (printed once; store it as a CI secret, e.g. `FLAKEHUNTER_TOKEN`):

```
TOKEN_REPO_FULL_NAME=<owner>/<repo> bun run --env-file=apps/api/.env scripts/create-repo-token.ts
```

Upload from a GitHub Actions step, after your tests have written `junit.xml`:

```yaml
- name: Upload test report to FlakeHunter
  if: always()
  run: |
    curl --fail-with-body -X POST "$FLAKEHUNTER_URL/api/reports" \
      -H "Authorization: Bearer $FLAKEHUNTER_TOKEN" \
      -H "Content-Type: application/xml" \
      -H "X-FH-Run-Id: ${{ github.run_id }}" \
      -H "X-FH-Run-Attempt: ${{ github.run_attempt }}" \
      -H "X-FH-Sha: ${{ github.event.pull_request.head.sha || github.sha }}" \
      -H "X-FH-Branch: ${{ github.head_ref || github.ref_name }}" \
      -H "X-FH-Workflow: ${{ github.workflow }}" \
      --data-binary @junit.xml
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
counts; a first upload returns `201`. Bodies up to 11 MB are accepted.

Read endpoints use the global `API_TOKEN` as the bearer token. `repo` is a numeric id or
`owner/name`; `since` is an ISO-8601 timestamp (default: 30 days ago). List endpoints take
`limit` (default 50, max 200) and `offset`, and return `{ data, page: { limit, offset, total } }`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/repos` | Registered repos (`id`, `fullName`, `owner`, `name`), ordered by name |
| `GET /api/tests/flaky?repo=&since=&minRuns=` | Tests ranked by flake rate: commits where the test both passed and failed, divided by commits it ran on (skipped ignored; `minRuns` defaults to 5) |
| `GET /api/tests/:id/history?since=&status=` | Newest-first results for one test, with run details |
| `GET /api/repos/:id/summary?since=` | Totals for the dashboard: runs, tests, results, pass rate, flaky tests and flaky commits |

Every `/api` error has the same shape:

```json
{ "error": { "code": "validation_error", "message": "...", "details": [{ "path": "querystring.limit", "message": "..." }] }, "requestId": "req-1" }
```

Codes: `validation_error` (400), `unauthorized` (401), `not_found` (404), `payload_too_large` (413),
`invalid_report` (422), `internal_error` (500). `details` appears only on validation errors.

## Demo data

To demo FlakeHunter without wiring up a real repo, generate a fake CI history and upload it through
the real `POST /api/reports` endpoint. The data is a made-up storefront service with 47 tests: most
always pass, six are flaky (one only in the last week, one that stopped three weeks ago, two with
in-suite retries), one was broken until 12 days ago, and two are skipped. Failed runs are usually
re-run on the same commit, which is what makes flaky tests show up. Runs are spread over the last 30
days using `X-FH-Timestamp`, so history, `since` filters and trends have something to show.

1. Register the demo repo and mint its upload token (once):

   ```
   SEED_REPO_OWNER=flakehunter-demo SEED_REPO_NAME=storefront SEED_REPO_GITHUB_ID=900000001 \
     bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
   TOKEN_REPO_FULL_NAME=flakehunter-demo/storefront \
     bun run --env-file=apps/api/.env scripts/create-repo-token.ts
   ```

2. Seed it (the API must be running):

   ```
   DEMO_UPLOAD_TOKEN=<token from above> bun run seed:demo
   ```

   `DEMO_API_URL` points it at another API (default `http://localhost:3000`), `DEMO_DAYS` sets how
   far back to go (0 to 365, default 30), and `DEMO_SEED` changes the history (default 42).
   `bun run seed:demo --dry-run` generates and counts without uploading.

Seeding is safe to repeat: for a seed the runs are deterministic, so a second run reports every
upload as already present. About 130 uploads are sent, one at a time, and a `429` is waited out and
retried.

## Pointing GitHub at FlakeHunter

The API needs to be reachable from GitHub's servers. Locally, use a
[`cloudflared`](https://github.com/cloudflare/cloudflared) quick tunnel (no account needed):

```
bun run tunnel
```

This runs `cloudflared tunnel --url http://localhost:3000`, passes its output through, and writes the
full webhook URL (`<tunnel URL>/webhooks/github`) to `scripts/webhook-url.txt` (git-ignored,
overwritten each run). Pass another target if needed: `bun run tunnel http://localhost:4000`. The
hostname changes on every start, so the file is only valid for the tunnel that wrote it.

On the target repo: **Settings → Webhooks → Add webhook**
- Payload URL: the contents of `scripts/webhook-url.txt`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: select **Workflow runs** only

Once registered, any `workflow_run` `completed` event triggers FlakeHunter to fetch the run's
JUnit XML artifact (assumes a single artifact per run, zipped, containing `.xml` files), parse
it, and store results. Query `GET /repos/:id/flaky-tests` (bearer token required) to see what's
currently flagged as flaky.

## Known week-1 scope limits

- Single JUnit XML artifact per run is assumed (no multi-artifact merge)
- Only `workflow_run` `completed` events are handled
- Auth is a single static bearer token — no per-user accounts or OAuth
- `flaky_tests` is a live SQL view, not a materialized/refreshed table
