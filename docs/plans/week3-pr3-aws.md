FlakeHunter week 3, PR 3: host everything on AWS
Context
Tasks 1-10 of the week 3 plan are done (PR #2 merged; PR #3, the Next.js dashboard, is open). The remaining work was "deploy to Fly.io and Vercel" (docs/plans/week3-demo-web.md, tasks 11-13). The user would rather host everything on AWS, because it is more relevant to finding a job. This plan replaces tasks 11-13 and the Fly/Vercel recommendation. No code has been changed for it yet, and the previously drafted branch feat/week3-deploy was not created.

Decisions (confirmed with the user)
Scope: API on Lambda and the web dashboard on AWS; the database stays on Neon (no VPC or RDS Proxy).
IaC: AWS CDK in TypeScript, in a new infra/ workspace.
Web hosting: AWS Amplify Hosting (managed Next.js SSR from the GitHub repo).
Upload size: lower the raw-body limit and accept gzip.
Front door: API Gateway HTTP API in front of the Lambda (AWS's recommended stack; replaces the earlier Function URL choice). It adds stage/route throttling, access logs and a path to custom domains. It throttles per route, not per caller, so the per-upload-token limiter stays in the app (DynamoDB counter, task 6). Use the $default stage so there is no path prefix.
Database: Neon stays (confirmed again after reviewing AWS's DynamoDB/RDS suggestion: the flaky queries need SQL joins, CTEs and aggregation). DynamoDB is still used, for the rate-limit counters.
The user makes every commit; the agent never runs git commit. The agent does not run cdk deploy, cdk bootstrap or any command that touches the AWS account; the runbook gives exact commands.
What the code review found (apps/api)
app.ts exports a clean buildApp({db?, logger?}); only index.ts calls listen(). No timers or in-memory state, so a module-level app reused across warm invocations works.
@fastify/autoload (app.ts:35-39) loads routes/ at runtime; esbuild cannot see those imports, so routes would be missing from a bundle. Replace with explicit register(import, { prefix }) calls (routes: health, flaky, repos, runs, tests, routes/api/* under /api, routes/webhooks/github under /webhooks).
Upload limit: routes/api/reports.ts allows 11 MiB; a Lambda invoked synchronously rejects request bodies over about 6 MB (about 4.5 MB of raw payload after base64).
Env vars read straight from process.env and throw at boot: API_TOKEN, DATABASE_URL, GITHUB_PAT, GITHUB_WEBHOOK_SECRET. They must be loaded before buildApp().
DB: db/client.ts uses postgres-js with the default pool of 10 and no idle timeout; db/migrate.ts is a standalone script with a cwd-relative migrations path.
Webhook: processWorkflowRun downloads and unzips the artifact inside the request (fflate unzipSync, whole zip in memory). GitHub expects a reply within 10 seconds.
Runtime: CI and local dev use Bun 1.4.2, but the app source uses no Bun-only APIs. Lambda has no Bun runtime, so the bundle targets Node 22 (arm64); Bun stays the dev, test and package tool.
Auth exemptions match request.url; an HTTP API $default stage has no stage prefix, so they keep working (a named stage like /prod would have broken them, so do not use one).
API Gateway's own payload cap is 10 MB, but the Lambda's 6 MB synchronous limit is the binding one, so the upload-size decision is unchanged.
Step 0: AWS tooling and Agent Toolkit setup (first, before any code)
You asked to set up the Agent Toolkit for AWS following https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/setup-instructions/setup.md (fetched and read; nothing run yet). Profile flakehunter, project region us-east-2, "new AWS experience". Current machine state: uv 0.12.15 present; AWS CLI not installed; no ~/.aws; CDK not installed.

Steps, in the guide's order (Windows, PowerShell):

Install the AWS CLI: irm 'https://awscli.amazonaws.com/v2/install.ps1' | iex (downloads and runs AWS's installer script; the guide's Windows path; no shell-config edit on Windows).
aws configure set region us-east-2 --profile flakehunter.
aws login --region us-east-2 --profile flakehunter — you complete the browser sign-in (I never see or enter credentials). Credentials last 12 hours, renewable for 90 days.
Verify: aws sts get-caller-identity --profile flakehunter.
aws configure agent-toolkit --yes --region us-east-1 --profile flakehunter. The guide says the toolkit service exists only in us-east-1, so this and the next step deliberately use us-east-1 even though the project region is us-east-2. It writes MCP config for the AI tools it detects (this edits your Claude Code MCP configuration). Then add "env": { "AWS_MCP_PROXY_PROFILES": "flakehunter" } to the generated aws-mcp entry (not AWS_PROFILE).
Verify: aws agent-toolkit list-available-skills --region us-east-1 --profile flakehunter.
Fetch https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/rules/aws-starter-rules.md (the "new experience" rules) and append it to the project CLAUDE.md between <!-- BEGIN AWS Agent Toolkit rules --> and <!-- END AWS Agent Toolkit rules --> (idempotent: replace between the markers if they exist, never overwrite the rest). I will show you the rules text before writing it, because it becomes standing instructions for this repo.
Also install the CDK CLI (bun add -g aws-cdk or per-project in infra/; decided with the infra/ workspace in task 7).
Notes: uv is already installed, so the guide's uv install step is skipped. The MCP config change takes effect after restarting Claude Code. Anything that touches the AWS account (login, later cdk bootstrap/cdk deploy) stays with you or needs your explicit go-ahead per command.

Tasks (PR 3, on a new branch feat/week3-aws off main)
Each task is done only when its tests exist and bun run lint && bun run typecheck && bun run test is green (CI also runs build:web).

A. Make the API Lambda-ready (apps/api)

Explicit route registration. Remove autoload from app.ts; register each route module with its prefix, keeping ignorePattern irrelevant. Test: app.test.ts still builds the real app and every existing route test passes unchanged; add a test that lists registered routes so a forgotten module fails.
Lambda entry point. src/lambda.ts: load secrets, call buildApp() once at module level, wrap with @fastify/aws-lambda, export handler. Secrets come from SSM Parameter Store SecureString parameters, read once per cold start with @aws-sdk/client-ssm into process.env before buildApp() (a small loadSecrets(client, names) helper, tested with a fake client). index.ts stays as the local/Bun entry. Tests: invoke handler with an API Gateway HTTP API (payload v2) event (health check, an authenticated read over PGlite via buildApp({ db }) injection, a base64 webhook body whose HMAC still verifies).
DB settings for Lambda. db/client.ts takes options: max: 1 and idle_timeout when AWS_LAMBDA_FUNCTION_NAME is set, plus prepare: false when the URL is Neon's pooled (-pooler) endpoint. Document using the pooled connection string. Test the option mapping as a pure function.
Fix db/migrate.ts to resolve migrations from its own location (same bug fixed earlier in testDb.ts); test running it from another cwd. Migrations run from your machine or CI before deploy (bun run db:migrate), not inside the Lambda.
Upload size: gzip support. On POST /api/reports, a preParsing hook gunzips when Content-Encoding: gzip, enforcing the existing 11 MiB limit on the decompressed size (a zip-bomb guard: abort the stream when it exceeds the limit, return 413 payload_too_large). Uncompressed bodies over about 4.5 MB cannot reach Lambda; the docs and the 413 message say to gzip. Update the README upload snippet (gzip -c junit.xml | curl --data-binary @- -H "Content-Encoding: gzip" ...) and make scripts/seed-demo.ts gzip its uploads. Tests: gzip body ingests; bomb is rejected; malformed gzip is 400; plain bodies unchanged.
Rate limiting that works across instances. Not @fastify/rate-limit's in-memory store (it is per Lambda instance and ineffective). A small RateLimitStore interface with an in-memory implementation (tests, local dev) and a DynamoDB fixed-window counter (atomic UpdateItem ADD, key = sha256 of the bearer token or source IP, TTL attribute) used on Lambda. Applied in an onRequest hook on POST /api/reports before the token lookup, so floods of bad tokens do not hit Postgres. Limit and window from env (UPLOAD_RATE_LIMIT_MAX, UPLOAD_RATE_LIMIT_WINDOW_SECONDS), default set so the ~130-upload seed finishes (the seed already waits out 429). Add rate_limited to errorCodeSchema (packages/shared-types/src/api/common.ts) and plugins/errorHandler.ts, with a Retry-After header. Tests: Nth+1 request gets 429 in the standard body; limits are per key; other routes unaffected; unauthenticated flood gets 429 or 401 without a DB query.
B. Infrastructure with CDK (infra/, new workspace) 7. API stack. NodejsFunction (esbuild bundling, Node 22, arm64, ~1024 MB, 29 s timeout to match API Gateway's integration limit) for src/lambda.ts; HTTP API (aws-cdk-lib/aws-apigatewayv2 with the Lambda integration, payload format 2.0, $default stage, default route throttling, access logs to CloudWatch; no CORS because the browser never calls the API; the app does its own token auth); reserved concurrency (about 10) to bound cost and blast radius; DynamoDB table for rate-limit counters (TTL, on-demand billing); SSM SecureString parameters for the secrets (created out of band, referenced by name); least-privilege IAM; an AWS Budget alarm with email. Output: the API URL. Tests: aws-cdk-lib/assertions template tests (function runtime and env, HTTP API integration and throttling, table TTL, IAM scoped to the specific parameters and table). cdk synth runs in CI; CI never deploys. 8. Web stack. Amplify Hosting app connected to the GitHub repo (monorepo appRoot: apps/web, build spec installs Bun then bun install and bun run --cwd apps/web build, Next.js SSR platform), environment variables API_BASE_URL (the HTTP API URL), API_TOKEN and SITE_PASSWORD (required: production returns 503 without it). Connecting GitHub needs a one-time authorization in your account; the runbook documents it.

C. CI, docs and cleanup 9. Runbook docs/deployment.md: account prerequisites (aws configure, cdk bootstrap), ordered steps (create SSM parameters, bun run db:migrate against the demo Neon branch, cdk deploy, connect Amplify, set env vars, seed with DEMO_API_URL and DEMO_UPLOAD_TOKEN), the secrets table below, rotation, rollback (cdk deploy previous commit, Lambda aliases are out of scope), demo reset (Neon branch), teardown (cdk destroy), costs and the free-tier notes. 10. Docs update: README deployment pointer and the gzip upload snippet; CLAUDE.md (Lambda entry point, explicit routes instead of autoload, DB options, rate-limit store, gzip rule, scope limits: remove "no rate limiting"); mark Fly.io/Vercel in docs/plans/week3-demo-web.md as superseded by this plan. Optional small scripts/revoke-repo-token.ts (imports only from apps/api/src).

Secrets and env
Where	Variable	Notes
AWS SSM (API)	DATABASE_URL	demo Neon branch, pooled endpoint
AWS SSM (API)	API_TOKEN	read token for the web app; distinct from dev
AWS SSM (API)	GITHUB_PAT, GITHUB_WEBHOOK_SECRET	random placeholders on the demo; the webhook route stays inert
Lambda env	UPLOAD_RATE_LIMIT_MAX, UPLOAD_RATE_LIMIT_WINDOW_SECONDS, table name	not secret
Amplify (web)	API_BASE_URL	the HTTP API URL
Amplify (web)	API_TOKEN	same value as the API's; server-only, never NEXT_PUBLIC_
Amplify (web)	SITE_PASSWORD	the demo gate; required in production
Your shell	DEMO_UPLOAD_TOKEN	per-repo upload token for the demo repo, used only by the seed script
Upload protection layers: per-repo token (sha256, revocable, scoped to one repo); per-token rate limit in DynamoDB before any DB lookup; gzip bomb guard and size cap; reserved concurrency; budget alarm; web app behind the password gate; demo data in its own Neon branch.

Verification
Per task: lint, typecheck and tests green; CI also runs build:web and cdk synth.
Local Lambda check without AWS: invoke the handler with sample HTTP API v2 events (or sam local-style via the handler tests); confirm the esbuild bundle runs with node and serves /health.
Seed twice through the local API with gzip on (second run all 200 duplicates); a burst of uploads with a low limit returns 429 and the seed recovers.
After you deploy: curl the HTTP API URL /health, an authenticated read, an unauthenticated upload (401), then seed against it and check the Amplify site (wrong password rejected, overview and detail pages show the seeded history).
Out of scope
SQS-based async webhook processing, RDS or Aurora, API Gateway REST API/usage plans, WAF/CloudFront, custom domains, Lambda aliases and blue/green, Replacing apps/dashboard, OAuth, OpenAPI docs, Playwright e2e.

Risks
Amplify and Next 16 + Bun: Amplify's documented Next.js support may lag Next 16.3 and the Node.js-runtime proxy (the password gate). Verify with a first deploy early; fallback is Next on Lambda + CloudFront via OpenNext/SST, or an App Runner container.
HTTP API throttles per route, not per caller: the DynamoDB limiter handles per-token limits; route throttling, reserved concurrency and the budget alarm bound total cost, but do not eliminate it.
Cold starts (Node 22 + Fastify + Drizzle, SSM fetch) add roughly a second on the first request; acceptable for a demo.
Neon from Lambda: concurrency fan-out can exhaust connections; max: 1 plus the pooled endpoint mitigates it.
Webhook sync processing still runs inside the request; fine for tiny demo artifacts, and the follow-up is SQS.
Bundling: fastify, pino and @flakehunter/shared-types (TypeScript source) must be bundled, not externalised; the handler test against the real bundle catches this.
AWS account safety: no deploy or account-changing command is run by the agent; set the budget alarm before the first deploy.