# 0007: Host on AWS, keep the database on Neon

**Status:** Accepted (Part 4). Supersedes Part 3's plan to host the API on Fly.io and the dashboard on Vercel.

## Context

The public demo needed hosting. Part 3 recommended Fly.io and Vercel; AWS experience is more relevant to finding a
job. The flaky queries need SQL joins, CTEs and aggregation, which ruled out moving the data to DynamoDB.

## Decision

Run the API on AWS Lambda behind an API Gateway HTTP API and the dashboard on AWS Amplify Hosting, defined with AWS
CDK in TypeScript, in one Region (us-east-2). Keep Postgres on Neon, using its pooled endpoint from Lambda.

## Consequences

- The API had to become Lambda-ready: explicit route registration, secrets from SSM Parameter Store, one database
  connection per instance, gzip uploads for the 6 MB body cap, and a DynamoDB rate-limit counter shared across
  instances.
- CDK runs under Node and the Lambda is bundled by the project's own esbuild script, because both are slow or broken
  under Bun on Windows.
- Cost is bounded by API Gateway throttling, a budget that stops the API at 100%, and organization guardrails (SCPs).
- Deploying is manual, from the runbook in [deployment.md](../deployment.md).
