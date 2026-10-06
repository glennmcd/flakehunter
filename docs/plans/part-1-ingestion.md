# Part 1: Core ingestion

Ingest JUnit XML from GitHub Actions through a webhook, store it in Postgres and flag flaky tests.

## Prompt

> I'm building FlakeHunter: it ingests JUnit XML test reports from GitHub Actions, stores them in Postgres, and flags
> a test as flaky when it both passes and fails on the same commit. Stack: TypeScript end to end: a Node API
> Fastify) [sic], React dashboard and Postgres. Before writing any code, ask me questions about requirements and edge
> cases, then propose the data model, the folder structure and a [Part 1] task list.

## Plan

- **Requirements agreed first:** the full GitHub webhook flow (not a stub); flaky means a pass and a fail on the same
  commit SHA, whatever the workflow or job; a test is `classname + name`, scoped per repo; multi-repo from day one;
  one static API token, no OAuth.
- **Data model:** `repos`, `webhook_events` (deduplicated on the delivery id), `workflow_runs`, `test_suites`,
  `test_cases` and `test_results`, with `repo_id` and `head_sha` copied onto results for fast lookups. Flaky status is
  a SQL view (`flaky_tests`), not stored state.
- **Libraries:** Fastify, Drizzle ORM with drizzle-kit migrations, `fast-xml-parser`, Octokit, `fflate` for zips;
  Neon Postgres for dev and prod, PGlite in memory for tests.
- **Layout:** a Bun workspaces monorepo; `github/` (transport), `ingest/` (unzip, parse, persist) and `routes/`
  (thin HTTP adapters) kept apart so ingestion is testable without a server or GitHub.
- **Tasks:** schema and migrations; webhook route (signature check, dedupe, `workflow_run` `completed` only);
  artifact download and JUnit parsing (nested suites, failure vs error, skipped, retries via `occurrence_index`);
  flaky queries and read routes; a bare dashboard list; an end-to-end check with a test that fails about half the
  time.
- **Not in scope:** OAuth, multiple artifacts per run, `check_run` events, a materialized flaky flag, dashboard styling.

## Outcome

Built as planned. The end-to-end check runs against the fixture repo `glennmcd/flakehunter-test-fixture`, whose
"maybe flaky test" fails about half the time. The plain repo webhook with a PAT (the plan's fallback) was used instead
of a GitHub App. The routes from this part (`/repos`, `/flaky`, `/runs`, `/tests`) still exist but no longer have a
caller since Part 3's dashboard uses the Part 2 API.

## Decisions

- [0001: Postgres on Neon, PGlite for tests](../decisions/0001-postgres-on-neon.md)
- [0002: Flaky means a pass and a fail on the same commit](../decisions/0002-flaky-on-same-commit.md)
- [0003: Multi-repo schema from day one](../decisions/0003-multi-repo-schema.md)
- [0004: Build the full webhook flow first](../decisions/0004-full-webhook-flow-first.md)

## Full plan

[archive/part-1-plan.md](archive/part-1-plan.md), as approved, and the original decision notes,
[archive/part-1-decisions.md](archive/part-1-decisions.md).
