# Build plans

FlakeHunter was built in four parts, each planned with Claude Code before any code was written. Each page gives the
prompt, a short version of the plan and what actually shipped. The originals (the plans as approved for Parts 1, 3
and 4, and the prompt and decision notes for Parts 1 and 2) are in [archive/](archive/).

These build parts are unrelated to the "Part 1/Part 2" sections of [deployment.md](../deployment.md).

| Part | Goal |
| --- | --- |
| [Part 1: Core ingestion](part-1-ingestion.md) | Ingest JUnit XML through a GitHub webhook, store it in Postgres and flag flaky tests |
| [Part 2: The v1 REST API](part-2-api.md) | Upload reports from CI and read flaky-test data over `/api` |
| [Part 3: Dashboard and demo data](part-3-dashboard-demo.md) | A Next.js dashboard and a realistic fake CI history to demo it |
| [Part 4: Hosting on AWS](part-4-aws.md) | Run the API on Lambda and the dashboard on Amplify, defined in CDK |

The decisions behind them are recorded as ADRs in [../decisions/](../decisions/README.md).
