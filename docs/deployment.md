# Deploying FlakeHunter to AWS

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

Commands assume Git Bash from the repository root. Nothing here is run for you: deploying changes your AWS project
and costs money, so each step is yours to run and check.

## 0. Before you start

- **Spend limit and budget.** In AWS Settings (settings.aws.com) check your project's billing and spend limit. The
  stack also creates an account budget that emails you at 80% of the monthly amount (actual) and 100% (forecast); you
  turn it on with `-c alertEmail=...` in step 6. Do not deploy without it.
- **Tools.** `bun install` at the repo root; Node 22 or newer (the CDK app runs under Node); the AWS CLI signed in:
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

Use a separate Neon branch for the public demo, in Neon's **AWS us-east-2** region so it sits next to the Lambda.
In the Neon console create the branch and copy two connection strings from its Connect dialog:

| Name | Looks like | Used for |
| --- | --- | --- |
| Direct | host `ep-...us-east-2.aws.neon.tech` | migrations and the one-off setup scripts |
| Pooled | host `ep-...-pooler.us-east-2.aws.neon.tech` | the Lambda (`DATABASE_URL` parameter below) |

The API detects the `-pooler` host and turns off prepared statements, and on Lambda it keeps one connection per
execution environment, so many concurrent invocations do not exhaust Neon's connection limit.

Export the direct one for this shell session (never commit it):

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
export API_TOKEN="$(openssl rand -hex 32)"            # the dashboard's read token; keep it for step 7
put() { aws ssm put-parameter --profile flakehunter --region us-east-2 --type SecureString --overwrite \
          --name "/flakehunter/demo/$1" --value "$2" --query Version --output text; }
put DATABASE_URL "$POOLED_DATABASE_URL"
put API_TOKEN "$API_TOKEN"
put GITHUB_PAT "$(openssl rand -hex 20)"              # placeholder: the demo does not use the GitHub webhook
put GITHUB_WEBHOOK_SECRET "$(openssl rand -hex 32)"   # random, so no webhook delivery can ever verify
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
{ "context": { "alertEmail": "you@example.com", "monthlyBudgetUsd": 10 } }
```

Then look before you leap:

```bash
bun run --cwd infra cdk diff FlakeHunterApi --profile flakehunter
bun run --cwd infra cdk deploy FlakeHunterApi --profile flakehunter
```

Add `-c reservedConcurrency=N` if step 0 showed room. The outputs include `ApiUrl`, `FunctionName` and
`RateLimitTableName`. The budget emails ask you to confirm the subscription; do it.

Verify:

```bash
export API_URL='https://....execute-api.us-east-2.amazonaws.com'     # the ApiUrl output
curl -s "$API_URL/health"                                              # {"ok":true}
curl -s "$API_URL/api/repos"                                           # 401 unauthorized
curl -s -H "authorization: Bearer $API_TOKEN" "$API_URL/api/repos"     # the demo repository
```

The first request after a quiet period takes about a second longer (a cold start that also reads the secrets).
If it returns a 500, read the function's log group `/aws/lambda/<FunctionName>`; "Could not load secrets from SSM"
names the parameter that is missing.

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
refuses to serve at all without one. The first build normally starts by itself; if the Amplify console shows none:

```bash
aws amplify start-job --profile flakehunter --region us-east-2 --job-type RELEASE \
  --app-id <AmplifyAppId output> --branch-name main
```

Watch the build in the Amplify console. **First-deploy risks**, none of which can be tested without deploying: whether
the build image handles Bun 1.4.2 and `bun install --filter`, and whether Next 16's Node-runtime password gate
(`apps/web/src/proxy.ts`) runs on Amplify. If the build fails, the log names the command; the build spec is
`BUILD_SPEC` in `infra/lib/web-stack.ts`.

Verify the `SiteUrl` output:

```bash
curl -si "$SITE_URL" | head -3                      # 401 with a WWW-Authenticate: Basic header
curl -s -u any:the-password "$SITE_URL/repos/1" | head -c 200      # the overview page (find the id with /?list=1)
```

## Day-two operations

**Rotate a secret.** Overwrite the parameter (`put` from step 3), then make Lambda start fresh execution environments,
which re-read the secrets (any configuration change does this):

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

**Reset the demo.** Reset the Neon branch to its parent in the Neon console, run steps 2 and 7 again (the old upload
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
same second; the seed uploads one report at a time and backs off on a 429. The budget alert emails you but does not
stop spending, and reserved concurrency (step 0) limits how many run at once, not how many are billed. Only a spend
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

An automatic kill switch (a CloudWatch alarm on the request count that sets the function's reserved concurrency to 0)
is possible but not built. If you are being flooded now: set the function's concurrency to 0 to stop all invocations,
then restore it when it is over:

```bash
aws lambda put-function-concurrency --profile flakehunter --region us-east-2   --function-name <FunctionName output> --reserved-concurrent-executions 0
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
| CDK context (`~/.cdk.json` or `-c`) | `alertEmail`, `monthlyBudgetUsd` | budget alert address and amount (default 10) |
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
| Amplify build fails at `bun install` | Check the log for the Bun or filter error; see `BUILD_SPEC` in `infra/lib/web-stack.ts`. |
| First request is slow | Cold start; expected after idle periods. |
