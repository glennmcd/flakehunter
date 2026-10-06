# Part 4: Hosting on AWS

Run the API and the dashboard on AWS, defined in CDK, with the database staying on Neon.

## Prompt

*Paraphrased; no prompt file was kept.* Host everything on AWS instead of Fly.io and Vercel, because AWS is more
relevant to finding a job. Replace Part 3's hosting plan; keep the database on Neon. The agent never commits and never
runs commands that change the AWS account; a runbook gives the exact commands.

## Plan

**Make the API Lambda-ready**
- Register routes explicitly instead of autoloading them, since a bundler can't see runtime imports.
- A Lambda entry point that reads the four secrets from SSM Parameter Store at cold start.
- One database connection per Lambda instance, and no prepared statements on Neon's pooled endpoint.
- Accept gzip uploads (a Lambda request body is capped near 6 MB), with the size limit applied after decompression.
- Rate-limit uploads with a DynamoDB counter, which works across Lambda instances, unlike an in-memory one.

**Infrastructure (`infra/`, AWS CDK in TypeScript, us-east-2)**
- API stack: Lambda (Node 22, arm64) behind an API Gateway HTTP API on the `$default` stage, the rate-limit table,
  least-privilege IAM and a cost budget.
- Web stack: Amplify Hosting for the Next.js dashboard, built from the GitHub repo.

**Docs**: the runbook `docs/deployment.md` and CLAUDE.md updates.

## Outcome

All tasks were built and tested; deploying is done by hand from the runbook. Differences from the plan:
- Uploads are counted per source IP as well as per token, so a flood of invented tokens can't each start a fresh
  limit.
- The Lambda is bundled by the project's own esbuild script, because CDK's `NodejsFunction` fails with Bun on
  Windows. The CDK app runs under Node, which starts template validation in about 1 second instead of about 100.
- Reserved concurrency is optional, since a new account's limit of 10 leaves nothing to reserve.
- GitHub access for Amplify is optional; without it the app is created unconnected.

Added afterwards: a budget kill switch that sets the API's concurrency to 0 at 100% of the budget, and organization
guardrails (SCPs) in [infra/scp/](../../infra/scp/README.md).

## Decisions

- [0007: Host on AWS, keep the database on Neon](../decisions/0007-host-on-aws.md)

## Full plan

[archive/part-4-plan.md](archive/part-4-plan.md), as approved.
