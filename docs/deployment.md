# Setting up and deploying FlakeHunter

Both parts use the same hosted Postgres database, so start with "Create the database". Part 1 runs FlakeHunter on
your machine; Part 2 deploys it to AWS. For the CI upload snippet and the endpoint reference, see [api.md](api.md).

**Every command in this document is a bash command, run from the repository root.** On Windows, use Git Bash, not
PowerShell or Command Prompt: forms such as `NAME=value bun run ...` (setting a variable for one command), `export`
and `\` line continuations are bash syntax and fail in those shells. macOS and Linux terminals run bash or zsh, which
both work.

- [Create the database (Neon)](#create-the-database-neon)
- [Part 1: Run it locally](#part-1-run-it-locally)
- [Part 2: Deploy to AWS](#part-2-deploy-to-aws)
- [Deploying from a new clone or repository](#deploying-from-a-new-clone-or-repository)
- [Day-two operations](#day-two-operations), [What it costs](#what-it-costs),
  [Stopping a flood](#stopping-a-flood), [Troubleshooting](#troubleshooting)

# Create the database (Neon)

FlakeHunter uses a hosted Postgres database on [Neon](https://neon.com); you don't need a local Postgres server.
The free plan is enough.

1. **Create a project.** Sign up at <https://console.neon.tech> and create a project. Choose **AWS** as the cloud and
   **US East (Ohio)**, `us-east-2`, as the region, so the database sits next to the Lambda when you deploy to AWS.
   Any Postgres version Neon offers works. The project starts with one database (`neondb`) on one default branch,
   named `production` when the project is created in the console (`main` when created with the CLI or API).
2. **Create the branches.** Local development uses the default branch. The AWS demo gets its own branch (Part 2,
   step 1), so the public demo's data and tokens stay apart from your development data and can be reset on their
   own. A new branch starts as a copy of its parent's data, so create these now, while the project is still empty,
   even if you deploy to AWS later:
   - `demo-base`, from the default branch. It stays empty and is never used: it is the clean point the demo resets
     to (resetting a branch copies its parent's current data).
   - `demo`, from `demo-base`: the public demo's database.

   For each, open **Branches**, click **New branch**, choose the parent, keep **Current data**, and **untick
   "Automatically delete branch after"**. It is ticked by default with 1 day, and would delete the branch the next
   day.
3. **Copy the connection strings.** On the project dashboard, click **Connect** and select the branch. The
   **Connection pooling** toggle chooses which string the dialog shows; it is on by default.

   | String | Pooling | Looks like | Used for |
   | --- | --- | --- | --- |
   | Direct | off | host `ep-...us-east-2.aws.neon.tech` | the local API, migrations and the setup scripts |
   | Pooled | on | host `ep-...-pooler.us-east-2.aws.neon.tech` | the Lambda only (Part 2) |

   Migrations need the direct string, and one local process does not need pooling. On Lambda, many short-lived
   instances each open a connection, which is what Neon's pooler is for; the API detects the `-pooler` host and
   turns off prepared statements for it.
4. **Remove `&channel_binding=require`** from the end of each string and keep `?sslmode=require`. The Postgres driver
   FlakeHunter uses (postgres.js) does not support channel binding and would send the option to the server as an
   unknown setting; the connection is still encrypted with `sslmode=require`.

Treat each connection string like a password: it contains the database password. Keep it in `apps/api/.env` (git
ignores it) or in the AWS parameter store, and never commit it. If one leaks, reset the role's password in the Neon
console (**Roles**).

# Part 1: Run it locally

## Install and configure the API

1. Install dependencies:
   ```bash
   bun install
   ```
2. Copy the `.env.example` at the repo root to `apps/api/.env` and set:
   - `DATABASE_URL`: the **direct** connection string for the default branch, from "Create the database" above
   - `API_TOKEN`: any string; this is the bearer token the dashboard and API clients must send
   - `GITHUB_WEBHOOK_SECRET`: any string; must match the secret configured on the GitHub webhook
   - `GITHUB_PAT`: a classic GitHub PAT with `repo` + `workflow` scopes, used to list and download workflow run
     artifacts
3. Run migrations:
   ```bash
   bun run db:migrate
   ```
4. Start the API on <http://localhost:3000>:
   ```bash
   bun run dev:api
   ```

## Run the dashboard (`apps/web`)

A Next.js app (App Router) that reads from the API server-side, so the API token never reaches the
browser. Pages: `/` (repository list; goes straight to the repo when there is only one, `/?list=1` always lists),
`/repos/<id>` (summary and flakiest tests, with 7/30/90-day window, minimum-commits filter and paging) and
`/repos/<id>/tests/<id>` (result timeline and history for one test).

1. Copy `apps/web/.env.example` to `apps/web/.env.local` and set:
   - `API_BASE_URL`: where the API runs (default `http://localhost:3000`)
   - `API_TOKEN`: the API's read token (the same value as `API_TOKEN` in `apps/api/.env`)
   - `SITE_PASSWORD`: password for the site-wide gate; leave empty to disable it locally
2. With the API running, start it:
   ```bash
   bun run dev:web
   ```
   It serves on <http://localhost:3001> (the API uses 3000).

**Site password.** When `SITE_PASSWORD` is set, every page and asset is behind HTTP Basic auth: the
browser prompts once, and you can enter any username with the password. When it is unset the site
is open in development, but a production build **refuses to serve (503)** rather than going public
by accident. Basic auth sends the password with every request, so only expose the site over HTTPS
(Amplify Hosting does this for you).

`bun run build:web` makes a production build (CI runs it).

## Demo data

To demo FlakeHunter without wiring up a real repo, generate a fake CI history and upload it through
the real `POST /api/reports` endpoint. The data is a made-up storefront service with 47 tests: most
always pass, six are flaky (one only in the last week, one that stopped three weeks ago, two with
in-suite retries), one was broken until 12 days ago, and two are skipped. Failed runs are usually
re-run on the same commit, which is what makes flaky tests show up. Runs are spread over the last 30
days using `X-FH-Timestamp`, so history, `since` filters and trends have something to show.

1. Register the demo repo and mint its upload token (once):

   ```bash
   SEED_REPO_OWNER=flakehunter-demo SEED_REPO_NAME=storefront SEED_REPO_GITHUB_ID=900000001 \
     bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
   TOKEN_REPO_FULL_NAME=flakehunter-demo/storefront \
     bun run --env-file=apps/api/.env scripts/create-repo-token.ts
   ```

2. Seed it (the API must be running):

   ```bash
   DEMO_UPLOAD_TOKEN=<token from above> bun run seed:demo
   ```

   `DEMO_API_URL` points it at another API (default `http://localhost:3000`), `DEMO_DAYS` sets how
   far back to go (0 to 365, default 30), and `DEMO_SEED` changes the history (default 42).
   `bun run seed:demo --dry-run` generates and counts without uploading.

Seeding is safe to repeat: for a seed the runs are deterministic, so a second run reports every
upload as already present. About 130 uploads are sent, one at a time, and a `429` is waited out and
retried. The dashboard then shows the demo repo at <http://localhost:3001>.

## Register a repo

FlakeHunter needs a `repos` row before it will ingest anything from a given GitHub repo. Seed one
with:

```bash
SEED_REPO_OWNER=<owner> SEED_REPO_NAME=<repo> SEED_REPO_GITHUB_ID=<github numeric repo id> \
  bun run --env-file=apps/api/.env scripts/seed-dev-repo.ts
```

Get the numeric GitHub repo id with `gh api repos/<owner>/<repo> --jq '.id'`. To upload reports from CI you also need
an upload token for the repo; see [api.md](api.md#uploading-reports-from-ci).

## Point GitHub at FlakeHunter (webhook)

The API needs to be reachable from GitHub's servers. Locally, use a
[`cloudflared`](https://github.com/cloudflare/cloudflared) quick tunnel (no account needed):

```bash
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
it, and store results. Only runs of the repo's own code are ingested: runs from forks are skipped,
and so are runs started by triggers other than `push`, `pull_request`, `merge_group`, `schedule`
and `workflow_dispatch` (for example `pull_request_target`, which is often used to run fork code),
because whoever writes a run's code controls its artifact. An artifact over 10 MB zipped, or whose XML files
decompress to more than 11 MB together, is refused; the reason is recorded in
`webhook_events.processing_error`.

## MCP server

`packages/mcp-server` lets an AI assistant ask FlakeHunter which tests are flaky and how a test has failed. With the
API running, start it over stdio:

```bash
API_BASE_URL=http://localhost:3000 API_TOKEN=<token> bun run --cwd packages/mcp-server start
```

Configuration and registering it in Claude Code are in
[packages/mcp-server/README.md](../packages/mcp-server/README.md).

## Scope limits

- One JUnit XML artifact per run is assumed (no multi-artifact merge), and only `workflow_run` `completed` events are
  handled.
- Reads use a single static bearer token; upload tokens are per repo. There are no user accounts or OAuth.
- `flaky_tests` is a live SQL view, not a materialized table.

# Part 2: Deploy to AWS

The API runs on AWS Lambda behind an API Gateway HTTP API, the dashboard on AWS Amplify Hosting, and the database
stays on Neon. Everything lives in one AWS Region, **us-east-2** (your project's Region). The infrastructure is the
CDK app in `infra/`; the commands below are the only things you run by hand.

```
GitHub ──push──▶ Amplify Hosting (Next.js, password gate)
                      │ server-side fetch, bearer API_TOKEN
                      ▼
curl / CI ──▶ API Gateway HTTP API ──▶ Lambda (Fastify) ──▶ Neon Postgres
                                          │
                                          ├─ SSM Parameter Store (4 secrets, read at cold start)
                                          └─ DynamoDB (upload rate-limit counters)
```

Commands are bash, run from the repository root (see the note at the top). Nothing here is run for you: deploying changes your AWS project
and costs money, so each step is yours to run and check.

Steps 0 to 8 build everything from nothing. If the stacks already exist and you are deploying from a new clone or a new
GitHub repository, go to "Deploying from a new clone or repository" after step 8.

## 0. Before you start

- **Spend limit and budget.** In AWS Settings (settings.aws.com) check your project's billing and spend limit. The
  stack also creates an account budget (default $30 a month) that emails you at 80% (actual) and 100% (forecast),
  and at 100% actual **stops the API** by setting its reserved concurrency to 0 (see "Stopping a flood"); you turn it
  on with `-c alertEmail=...` in step 6. Do not deploy without it. Organization-level guardrails (SCPs) are in
  `infra/scp/`.
- **Tools.** `bun install` at the repo root (the CDK CLI is installed by it; without it every `cdk` command fails with
  "Cannot find module"); Node 22 or newer (the CDK app runs under Node); the AWS CLI signed in:
  ```bash
  aws login --region us-east-2 --profile flakehunter
  aws sts get-caller-identity --profile flakehunter     # shows the project and role
  ```
  Logins last 12 hours; run `aws login` again when a command says the session expired.
- **Lambda concurrency quota.** A new account may have a total of 10 concurrent executions, which leaves no room to
  reserve any for this function (AWS needs 10 unreserved). Check, and only pass `-c reservedConcurrency=N` if the
  quota is comfortably above 10:
  ```bash
  aws lambda get-account-settings --profile flakehunter --region us-east-2 --query 'AccountLimit.ConcurrentExecutions'
  ```

## 1. Demo database (Neon)

Follow "Create the database" at the top of this document, if you haven't already, and use the `demo` branch
for the public demo (its step 2). Copy **both** connection strings for that branch (its step 3): the direct one for
migrations and the setup scripts below, the pooled one for the Lambda's `DATABASE_URL` parameter (step 3). On Lambda
the API also keeps one connection per execution environment, so many concurrent invocations do not exhaust Neon's
connection limit.

Export both for this shell session (never commit them):

```bash
export DIRECT_DATABASE_URL='postgres://...'
export POOLED_DATABASE_URL='postgres://...-pooler...'
```

## 2. Migrate and register the demo repository

```bash
DATABASE_URL="$DIRECT_DATABASE_URL" bun run db:migrate

DATABASE_URL="$DIRECT_DATABASE_URL" \
SEED_REPO_OWNER=flakehunter-demo SEED_REPO_NAME=storefront SEED_REPO_GITHUB_ID=900000001 \
  bun run scripts/seed-dev-repo.ts

DATABASE_URL="$DIRECT_DATABASE_URL" TOKEN_REPO_FULL_NAME=flakehunter-demo/storefront \
  bun run scripts/create-repo-token.ts        # prints the upload token once: copy it now
export DEMO_UPLOAD_TOKEN='...'
```

Migrations are forward-only. Use the direct connection for them (the pooled one also works, but is not recommended
for schema changes).

## 3. Secrets in Parameter Store

The Lambda reads four SecureString parameters under `/flakehunter/demo/` when a new execution environment starts. The
stack grants it read access to exactly these four and never creates them, so no secret passes through CloudFormation.

```bash
export API_TOKEN="$(openssl rand -hex 32)"            # the dashboard's read token; keep it for steps 6 and 8
put() { MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile flakehunter --region us-east-2 --type SecureString \
          --overwrite --name "/flakehunter/demo/$1" --value "$2" --query Version --output text; }
put DATABASE_URL "$POOLED_DATABASE_URL"
put API_TOKEN "$API_TOKEN"
put GITHUB_PAT "$(openssl rand -hex 20)"              # placeholder: the demo does not use the GitHub webhook
put GITHUB_WEBHOOK_SECRET "$(openssl rand -hex 32)"   # random, so no webhook delivery can ever verify
```

`MSYS_NO_PATHCONV=1` matters in Git Bash on Windows: without it Git Bash rewrites an argument that starts with `/`
into a Windows path (`/flakehunter/demo/DATABASE_URL` becomes `C:/.../flakehunter/demo/DATABASE_URL`), and AWS
rejects it with "Parameter name must be a fully qualified name". It is not needed in PowerShell or on macOS and Linux.
To see what was stored (names only, nothing decrypted):

```bash
MSYS_NO_PATHCONV=1 aws ssm get-parameters-by-path --path /flakehunter/demo/ --profile flakehunter \
  --region us-east-2 --query "Parameters[].Name"
```

`GITHUB_PAT` and `GITHUB_WEBHOOK_SECRET` must exist (the API refuses to start without them), but random values make
the webhook route inert. Shell history can hold what you typed; clear the variables when you are done
(`unset API_TOKEN DIRECT_DATABASE_URL POOLED_DATABASE_URL`).

## 4. GitHub access for Amplify

Amplify needs to read the repository and register a webhook so every push builds. Create a GitHub token and store it
in Secrets Manager (CloudFormation resolves it at deploy time; it never appears in the template):

1. GitHub, Settings, Developer settings, Personal access tokens (classic), with the `repo` and `admin:repo_hook`
   scopes. Check Amplify's current documentation for the scopes it asks for, since they have changed before.
2. ```bash
   aws secretsmanager create-secret --profile flakehunter --region us-east-2 \
     --name flakehunter/github-token --secret-string "$GITHUB_TOKEN"
   ```

Skip this step to create the Amplify app unconnected and attach the repository in the Amplify console instead.

## 5. Bootstrap CDK (once per account and Region)

```bash
bun run --cwd infra cdk bootstrap --profile flakehunter aws://<account-id>/us-east-2
```

This creates the staging bucket and roles CDK uses. Use the account id from `sts get-caller-identity`.

## 6. Deploy the API

Put your settings where they are not forgotten. A user-level `~/.cdk.json` keeps them out of the repository and means
every later deploy sees the same context (a deploy without `alertEmail` would delete the budget):

```json
{ "context": { "alertEmail": "you@example.com", "monthlyBudgetUsd": 30 } }
```

Then look before you leap:

```bash
bun run --cwd infra cdk diff FlakeHunterApi --profile flakehunter
bun run --cwd infra cdk deploy FlakeHunterApi --profile flakehunter
```

Add `-c reservedConcurrency=N` if step 0 showed room (10 suits the default throttle). If you skipped it, add it later by
running the same `cdk deploy` with the flag; CDK changes the function in place. Keep every context value in
`~/.cdk.json` so later deploys do not drop one. The outputs include `ApiUrl`, `FunctionName` and
`RateLimitTableName`. The budget emails ask you to confirm the subscription; do it.

Verify:

```bash
export API_URL='https://....execute-api.us-east-2.amazonaws.com'     # the ApiUrl output
curl -s "$API_URL/health"                                              # {"ok":true}
curl -s "$API_URL/api/repos"                                           # 401 unauthorized
curl -s -H "authorization: Bearer $API_TOKEN" "$API_URL/api/repos"     # the demo repository
```

The first request after a quiet period takes about a second longer (a cold start that also reads the secrets).
If it returns a 500, read the function's log; "Could not load secrets from SSM" names the parameter that is missing.
The stack gives the log group a generated name (it is not `/aws/lambda/<FunctionName>`), so ask the function for it:

```bash
aws lambda get-function-configuration --profile flakehunter --region us-east-2 --function-name <FunctionName output> --query LoggingConfig.LogGroup --output text
```

Then read the last 15 minutes, using that name as `<log group>`:

```bash
aws logs tail --profile flakehunter --region us-east-2 <log group> --since 15m
```

## 7. Seed the demo history

```bash
DEMO_API_URL="$API_URL" DEMO_UPLOAD_TOKEN="$DEMO_UPLOAD_TOKEN" bun run seed:demo
```

About 130 gzip-compressed uploads go through the real endpoint. The upload limit is 120 per minute per token and per
IP, so the seeder may wait out a 429 once; that is expected. Run it a second time: every upload should report as
already present.

## 8. Deploy the dashboard

```bash
bun run --cwd infra cdk deploy FlakeHunterWeb --profile flakehunter \
  --parameters FlakeHunterWeb:ApiToken="$API_TOKEN" \
  --parameters FlakeHunterWeb:SitePassword='choose-a-password-of-8-or-more-characters' \
  -c repository=https://github.com/<owner>/<repo> -c githubTokenSecretName=flakehunter/github-token
```

Add the two `-c` flags to `~/.cdk.json` too. The site password is what visitors type (any username); production
refuses to serve at all without one. Both secrets may use only letters, digits and `! % * + , - . / : = ? @ ^ _ ~`
(no `#`, `$`, quotes or spaces): the build writes them into a `.env` file, where those characters would silently
change the value, so the deploy refuses them. The first build normally starts by itself; if the Amplify console shows none:

```bash
aws amplify start-job --profile flakehunter --region us-east-2 --job-type RELEASE \
  --app-id <AmplifyAppId output> --branch-name main
```

Watch the build in the Amplify console. **First-deploy risks**, none of which can be tested without deploying: whether
the build image handles Bun 1.4.2 (it does), and whether Next 16's Node-runtime password gate
(`apps/web/src/proxy.ts`) runs on Amplify. If the build fails, the log names the command; the build spec is
`BUILD_SPEC` in `infra/lib/web-stack.ts`.

Verify the `SiteUrl` output:

```bash
export SITE_URL='https://main.<app-id>.amplifyapp.com'   # the SiteUrl output
curl -si "$SITE_URL" | head -3                      # 401 with a WWW-Authenticate: Basic header
curl -s -u any:the-password "$SITE_URL/repos/1" | head -c 200      # the overview page (find the id with /?list=1)
```

Every page ends with a version line such as `v0.0.2 · a1b2c3d`: the `version` in `apps/web/package.json` and the first
7 digits of the commit Amplify built. Check that it names the commit you pushed:

```bash
curl -s -u any:the-password "$SITE_URL/" | grep -o 'v[0-9][^<]*'
```

If only `v0.0.2` shows, with no commit, Amplify did not provide `AWS_COMMIT_ID` to the build. The dashboard still works;
the commit is just not shown. Bump the version in `apps/web/package.json` when you release.

## Deploying from a new clone or repository

Use this when steps 0 to 8 are already done (the stacks `FlakeHunterApi` and `FlakeHunterWeb` exist) and the code now
comes from a different checkout, for example a clean repository. Steps 1 to 5 are not repeated: the Neon branch, the
four parameters, the GitHub token secret and the CDK bootstrap all stay where they are. What ties a checkout to the
existing resources is the **stack names**, plus your user-level `~/.cdk.json` context, which is not part of any
repository.

### A. Check the new clone (nothing touches AWS)

A clean clone has none of the git-ignored files: `node_modules`, the `.env` files and the build output (`infra/dist`,
`infra/cdk.out`). The deploy needs only the first and the last, and `cdk` rebuilds the bundle itself. The `.env` files
matter only for running locally (copy them from the `.env.example` files).

```bash
bun install --frozen-lockfile
```

Do this first. Without it `cdk` cannot start at all, because the CDK CLI itself is a dependency of `infra/`. The
symptom is `Cannot find module '...\infra\node_modules\aws-cdk\bin\cdk'` from any `bun run --cwd infra cdk ...`
command. Check that it worked:

```bash
ls infra/node_modules/aws-cdk/bin/cdk
```

Run the same checks CI runs. A deploy from a clone that fails them is not worth starting:

```bash
bun run lint && bun run typecheck && bun run test
```

Bundle the Lambda and synthesize both stacks. This deploys nothing:

```bash
bun run synth:infra
```

### B. Update the API stack

Sign in again if the session expired (`aws login --region us-east-2 --profile flakehunter`), then see what would
change:

```bash
bun run --cwd infra cdk diff --profile flakehunter
```

Read it before you deploy anything:

- **No changes, or only changes you made in the code:** expected.
- **The stack would be created:** you are in the wrong account or Region. Stop.
- **The budget, the `BudgetStop*` resources or the alert email would be deleted:** `alertEmail` is missing from
  `~/.cdk.json` (step 6). Stop and fix the context, or the deploy removes the cost guardrails.
- **Only the budget changes, and its notification address differs (`may be replaced`):** `alertEmail` in
  `~/.cdk.json` is not the address the deployed budget has. That is expected after you change it. CloudFormation
  creates the new budget before it deletes the old one, and the new address gets a subscription confirmation
  email that you must accept: until you do, the 80% and 100% alerts do not reach you. The kill switch is not affected.
- **The diff lists IAM changes:** CDK asks you to approve them. Read them; do not skip the prompt.

If the `FlakeHunterApi` part of the diff is empty, there is nothing to deploy. Otherwise:

```bash
bun run --cwd infra cdk deploy FlakeHunterApi --profile flakehunter
```

Then repeat the checks at the end of step 6 (`/health`, a 401 without the token, the demo repository with it). If an
organization SCP is attached to the account (`infra/scp/`), a deploy that creates something it does not allow fails
with `explicit deny in a service control policy`; the message names the action to add to the allow-list.

### C. Connect the dashboard to the new GitHub repository

Amplify registers its webhook on the repository it was connected to when the app was created. If the code moved to a
new repository, even one with **the same name and URL**, that webhook stays with the old repository (it follows
the old one when you rename it). Pushes to the new repository then build nothing. `cdk diff` does not show it either:
when the URL is unchanged, the `FlakeHunterWeb` template is unchanged.

Check whether the new repository has an Amplify webhook. This prints only the host of each webhook, because the
full URL carries a token:

```bash
gh api repos/<owner>/<repo>/hooks --jq '.[].config.url | capture("^(?<host>https?://[^/?]+)").host'
```

Amplify's webhook shows as `https://amplify-webhooks.us-east-2.amazonaws.com`. If it is there, skip to the
verification below. If there is none (a new repository starts with no webhooks), recreate the dashboard stack. It holds no data; the
API, the database and the secrets are not touched. Creating an Amplify app with a repository and a token is what
registers the webhook, so a recreate is the dependable way to get one.

The GitHub token in the `flakehunter/github-token` secret must be able to see the new repository: a classic token
with `repo` and `admin:repo_hook` covers every repository you own, but a fine-grained token lists specific
repositories and needs the new one added. Then:

```bash
bun run --cwd infra cdk destroy FlakeHunterWeb --profile flakehunter
```

Deploy it again with the command from step 8 (the same two `--parameters`, and `-c repository=` set to the new
repository's URL, which is already in `~/.cdk.json` if you added the `-c` flags there):

```bash
bun run --cwd infra cdk deploy FlakeHunterWeb --profile flakehunter \
  --parameters FlakeHunterWeb:ApiToken="$API_TOKEN" \
  --parameters FlakeHunterWeb:SitePassword='<the site password>' \
  -c repository=https://github.com/<owner>/<repo> -c githubTokenSecretName=flakehunter/github-token
```

The recreated app has a new id, so the `SiteUrl` output changes. Update any bookmark or link that holds the old one.
`ApiToken` is the same value as the `API_TOKEN` parameter; read it back from your password manager, or rotate it (see
"Rotate a secret") if you no longer have it.

Verify, as in step 8, and confirm the webhook now exists on the new repository (the command above) and that a push
starts a build:

```bash
aws amplify list-jobs --profile flakehunter --region us-east-2 --app-id <AmplifyAppId output> --branch-name main --max-results 3
```

Last, look at the old repository's webhooks and delete any Amplify one that is left:

```bash
gh api repos/<owner>/<old-repo>/hooks --jq '.[] | {id, host: (.config.url | capture("^(?<h>https?://[^/?]+)").h)}'
```

### D. Afterwards

Clear the secrets from your shell (`unset API_TOKEN DIRECT_DATABASE_URL POOLED_DATABASE_URL`) and keep `~/.cdk.json`:
it is what makes the next deploy from any clone see the same context. The old repository can stay private as an
archive; nothing deployed refers to it any more.

## Day-two operations

**Rotate a secret.** Overwrite the parameter (`put` from step 3), then make Lambda start fresh execution environments,
which re-read the secrets (any configuration change does this). First look up the function name, which is the
`FunctionName` output of the `FlakeHunterApi` stack:

```bash
aws cloudformation describe-stacks --profile flakehunter --region us-east-2 --stack-name FlakeHunterApi --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text
```

Then use it as `<FunctionName output>`:

```bash
aws lambda update-function-configuration --profile flakehunter --region us-east-2 \
  --function-name <FunctionName output> --description "secrets rotated $(date -u +%FT%TZ)"
```

If you rotate `API_TOKEN`, also redeploy the dashboard with the new value (`--parameters FlakeHunterWeb:ApiToken=...`).

**Rotate the upload token.** Mint a new one (step 2), update wherever it is stored (CI secret, `DEMO_UPLOAD_TOKEN`), then
revoke the old one; revoking takes effect on its next request:

```bash
DATABASE_URL="$DIRECT_DATABASE_URL" REVOKE_TOKEN='<old token>' bun run scripts/revoke-repo-token.ts
```

**Roll back.** Check out the previous good commit and run the same `cdk deploy`; CloudFormation rolls a failed deploy
back by itself. For the dashboard, redeploy an earlier build from the Amplify console. Database migrations do not roll
back; write a new migration instead.

**Reset the demo.** In the Neon console, reset the `demo` branch to its parent, `demo-base` (empty; never reset to
the default branch, which would copy your development data into the public demo), then run steps 2 and 7 again (the old upload
token is gone with the data, so mint a new one and update `DEMO_UPLOAD_TOKEN`).

**Tear down.** `bun run --cwd infra cdk destroy FlakeHunterWeb FlakeHunterApi --profile flakehunter`, then delete what
the stacks never owned: the four parameters under `/flakehunter/demo/`, the `flakehunter/github-token` secret, and
the Neon branch. The budget is removed with the stack.

## What it costs

An estimate for the stack this runbook builds, at **list (pay-as-you-go) prices** read from the AWS Price List API for
us-east-2 on 2026-10-02, with all arithmetic done by script. It is not a quote: it does not apply free-tier allowances or
credits (the Free Tier API had no plan data for this project, so none are assumed), and the traffic is assumed, not
measured. Neon is billed by Neon and is not included.

**Monthly cost, in US dollars**

| Scenario | Dashboard page views | Uploads | API requests | Estimated cost |
| --- | --- | --- | --- | --- |
| Idle (a portfolio link nobody visits) | 300 | 0 | 600 | about $0.54 |
| Typical (a demo you show people) | 3,000 | 200 | 6,200 | about $1.67 |
| Busy (a lot of interest) | 30,000 | 5,000 | 65,000 | about $6.03 |

Where it goes in the typical month:

| Item | Price used | Typical month |
| --- | --- | --- |
| Amplify builds | $0.01 per build minute; 20 builds of 5 minutes | $1.00 |
| Amplify data transfer out | $0.15 per GB; about 0.4 MB per page view | $0.18 |
| Secrets Manager (the GitHub token secret) | $0.40 per secret per month | $0.40 |
| Amplify server rendering | $0.30 per million requests plus $0.20 per GB-hour | $0.05 |
| Amplify artifact storage | $0.023 per GB-month; about 0.5 GB | $0.01 |
| Lambda | $0.20 per million requests plus $0.0000133334 per GB-second (arm64, 1 GB) | $0.02 |
| API Gateway HTTP API | $1.00 per million requests | $0.01 |
| CloudWatch Logs | $0.50 per GB ingested, $0.03 per GB-month stored (14 days) | $0.01 |
| DynamoDB rate-limit counters | $0.625 per million writes (two per upload) | under $0.01 |
| Systems Manager parameters, Budgets, CloudFormation, CDK bootstrap bucket | standard parameters and the budget have no charge; the bucket is about 0.05 GB | about $0.00 |

The pay-per-request services (Lambda, API Gateway, DynamoDB) are almost free at this size. The bill is mostly Amplify
builds and the one Secrets Manager secret. If you attach the repository in the Amplify console instead of using a
token (step 4), the secret and its $0.40 go away.

**One-time cost of following the runbook:** about $0.50, nearly all of it the first ten Amplify builds. Seeding twice is
260 uploads, which costs under a cent.

**Assumptions** (change them and the numbers move): each page view makes 2 API calls; a request bills 0.12 s warm,
1.5 s cold, with 5% cold, an average of 0.19 s at 1 GB; about 1.5 KB of function logs and 0.5 KB of access logs per
request; Amplify server rendering of 0.15 s per request at 1 GB with two requests per page view; a 5-minute build on
Amplify's standard build instance. The first Amplify builds may take longer while Bun installs.

**The worst case is set by the throttle, not by your traffic.** The HTTP API accepts up to **10 requests per second**
(burst 20) by default; over that, API Gateway answers 429 itself without running the Lambda. If someone sent 10 per
second continuously for a month (about 26 million requests), API Gateway, Lambda and logs would cost roughly $70 to
$120. The same flood at an earlier default of 50 per second would have cost roughly $370 to $610, so raise the limit
only if real traffic needs it: `-c throttleRate=N` (steady) and `-c throttleBurst=M` (burst, default twice N) at
deploy time. A dashboard page view makes two API calls, so 10 per second is about five visitors loading a page in the
same second; the seed uploads one report at a time and backs off on a 429. The budget emails you and, at 100% of
actual spend, stops the API (see "Stopping a flood"), but its data lags by hours, so a flood runs up cost before it
reacts. Reserved concurrency (step 0) limits how many run at once, not how many are billed. Only a spend
limit in AWS Settings (billing) is a hard dollar cap; see "Stopping a flood" below.

To redo this with current prices, ask for the AWS Price List entries for Lambda (`AWSLambda`), API Gateway
(`AmazonApiGateway`), DynamoDB (`AmazonDynamoDB`), CloudWatch (`AmazonCloudWatch`), Amplify (`AWSAmplify`) and Secrets
Manager (`AWSSecretsManager`) in us-east-2, or use the AWS Pricing Calculator. Prices and free-tier rules change, so
treat the budget alert and your project's spend limit as the real protection.

## Stopping a flood

Layers, from fastest and cheapest to blunt:

1. **The API throttle** (above): a hard per-second cap that needs no action from you.
2. **Reserved concurrency** (step 0, if your quota allows): caps how many Lambda executions run at once.
3. **A spend limit** in AWS Settings, Billing (project owners only; check your plan): AWS pauses the project when it is
   exceeded. It is the only true dollar cap, and it stops everything, including the dashboard. Set it just above what
   you would tolerate, with the budget email set below it so you hear first.
4. **Not available here:** AWS WAF rate rules cannot be attached to an HTTP API (AWS supports only REST APIs), and
   budget actions can only apply IAM or SCP policies, stop EC2 or RDS instances, or start an SSM automation, and
   budget data refreshes only a few times a day, so a budget cannot react to a flood in time.

**Budget kill switch.** At 100% of the monthly budget (actual spend) the budget publishes to an SNS topic and the
`BudgetStopFunction` sets the API function's reserved concurrency to 0 (`infra/lambda/budget-stop`). Budget data lags
by hours, so it caps a slow overrun, not a flood. To resume after it fires, run the `delete-function-concurrency`
command below. A CloudWatch alarm on the request count would react faster but is not built. If you are being
flooded now: set the function's concurrency to 0 to stop all invocations,
then restore it when it is over. First look up the function name, which is the `FunctionName` output of the
`FlakeHunterApi` stack:

```bash
aws cloudformation describe-stacks --profile flakehunter --region us-east-2 --stack-name FlakeHunterApi --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text
```

Then use it as `<FunctionName output>`. Stop the API:

```bash
aws lambda put-function-concurrency --profile flakehunter --region us-east-2 --function-name <FunctionName output> --reserved-concurrent-executions 0
```

Restore it when the flood is over:

```bash
aws lambda delete-function-concurrency --profile flakehunter --region us-east-2 --function-name <FunctionName output>
```

(The delete command restores normal unreserved behaviour. Setting the concurrency to 0 can fail on accounts whose
quota leaves no room to reserve; then lower the throttle with `-c throttleRate=1` and redeploy.)

## Protection against abuse

Upload (`POST /api/reports`) is the only public write path. Layers: a per-repository token (only its hash is stored;
revocable); a limit of 120 requests per minute per token and per IP, counted in DynamoDB and checked before any
database lookup; gzip bodies are measured after decompression (11 MB cap, so a small file cannot expand into a huge
one); HTTP API throttling of 10 requests per second (burst 20); the dashboard behind a password; the demo data in its own Neon
branch. Reads need the separate `API_TOKEN`, which lives only in Parameter Store and in the Amplify app's server
settings, never in a browser.

## Secrets and settings

| Where | Name | Value |
| --- | --- | --- |
| SSM `/flakehunter/demo/` | `DATABASE_URL` | Neon pooled connection string |
| SSM `/flakehunter/demo/` | `API_TOKEN` | random; the dashboard's read token |
| SSM `/flakehunter/demo/` | `GITHUB_PAT`, `GITHUB_WEBHOOK_SECRET` | random placeholders; webhook stays inert |
| Secrets Manager | `flakehunter/github-token` | GitHub token Amplify uses to read the repository |
| CloudFormation parameter | `FlakeHunterWeb:ApiToken` | same as the `API_TOKEN` parameter |
| CloudFormation parameter | `FlakeHunterWeb:SitePassword` | the dashboard gate, 8 or more characters |
| CDK context (`~/.cdk.json` or `-c`) | `alertEmail`, `monthlyBudgetUsd` | budget alert address and amount (default 30) |
| CDK context | `reservedConcurrency` | optional Lambda concurrency cap |
| CDK context | `throttleRate`, `throttleBurst` | API requests per second and burst (defaults 10 and 20); the hard cap on flood cost |
| CDK context | `repository`, `githubTokenSecretName`, `branch` | the GitHub source for Amplify |
| Your shell | `DEMO_UPLOAD_TOKEN` | upload token for the demo repository, used by the seed script only |
| Lambda (set by CDK) | `UPLOAD_RATE_LIMIT_MAX`, `UPLOAD_RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_TABLE` | not secret |

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Dashboard returns 503 "site password is not configured" | `SitePassword` was empty; redeploy `FlakeHunterWeb` with the parameter. |
| Dashboard says it cannot reach the API or the token was rejected | `API_BASE_URL` wrong, or `ApiToken` differs from the `API_TOKEN` parameter; redeploy the web stack. |
| API returns 500 and logs "Could not load secrets from SSM" | A parameter is missing or empty, or the Lambda's role cannot read it; the message names it. |
| API returns 500 "RATE_LIMIT_TABLE is not set" | The Lambda was deployed outside the stack; deploy through CDK. |
| Upload returns 429 | The per-token or per-IP limit; wait the `Retry-After` seconds. The seeder does this itself. |
| Upload returns 413 | Over 11 MB after decompression, or an uncompressed body over about 4.5 MB (Lambda's request limit): send it gzip-compressed. |
| `cdk deploy` fails "Specified ReservedConcurrentExecutions ... decreases ... UnreservedConcurrentExecution" | Remove `reservedConcurrency`; the account's quota is too small to reserve any (step 0). |
| Amplify build fails at `bun install` | Check the log for the Bun error; see `BUILD_SPEC` in `infra/lib/web-stack.ts`. |
| Amplify build compiles, then fails "do not have the required package(s) installed" (typescript) | The install skipped the repo root, where TypeScript lives. The build spec must run a full `bun install --frozen-lockfile --linker hoisted`, not a `--filter` one. |
| Amplify build succeeds, then fails "The 'node_modules' folder is missing the 'next' dependency" | Bun's default linker keeps packages in a symlinked store, so `next` is not at the top of `node_modules`. The Amplify install needs `--linker hoisted` (as AWS requires of pnpm workspaces). |
| `bun run --cwd infra cdk ...` fails "Cannot find module '...\infra\node_modules\aws-cdk\bin\cdk'" | The dependencies are not installed, typical in a fresh clone (`node_modules` is git-ignored). Run `bun install --frozen-lockfile` at the repository root, then retry. |
| First request is slow | Cold start; expected after idle periods. |
| Pushes to the new GitHub repository do not start an Amplify build | The webhook is still on the old repository, and `cdk diff` shows nothing because the URL is the same. See "Deploying from a new clone or repository", section C: recreate `FlakeHunterWeb`. |
| `cdk deploy` fails "A budget or resource with the same name but a different internalId already exists" | An older version gave the budget a fixed name, so replacing it collided with itself. The stack is left in `UPDATE_ROLLBACK_COMPLETE`, which is fine: update to the current code (the budget has no fixed name now) and deploy again. The old budget is removed and a new one with a generated name replaces it. |
