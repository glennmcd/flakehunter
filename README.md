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

## Registering a repo

FlakeHunter needs a `repos` row before it will ingest anything from a given GitHub repo. Seed one
with:

```
SEED_REPO_OWNER=<owner> SEED_REPO_NAME=<repo> SEED_REPO_GITHUB_ID=<github numeric repo id> \
  bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
```

Get the numeric GitHub repo id with `gh api repos/<owner>/<repo> --jq '.id'`.

## Pointing GitHub at FlakeHunter

The API needs to be reachable from GitHub's servers. Locally, use a tunnel (e.g.
[`cloudflared`](https://github.com/cloudflare/cloudflared): `cloudflared tunnel --url
http://localhost:3000`, no account needed for a quick tunnel).

On the target repo: **Settings → Webhooks → Add webhook**
- Payload URL: `<your public URL>/webhooks/github`
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
