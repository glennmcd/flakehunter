# 0001: Postgres on Neon, PGlite for tests

**Status:** Accepted (Part 1)

## Context

FlakeHunter needs a real SQL database: the flaky queries group, join and aggregate. A solo project also wants no
local database server or Docker to run, and tests that need no network.

## Decision

Use Postgres. Dev and production run on Neon's hosted free tier; tests run against PGlite, an in-memory Postgres,
with the same migrations applied. SQLite was considered and rejected for its weaker upgrade path.

## Consequences

- No local Postgres: the app needs only a `DATABASE_URL`.
- Tests are fast and offline, and exercise the real SQL dialect, schema and views.
- Domain code takes Drizzle's generic `AnyDb` so it runs on both drivers. Raw `execute` results differ between them,
  so production queries use the query builder.
- Neon was kept when hosting moved to AWS ([0007](0007-host-on-aws.md)), with its pooled endpoint for Lambda.
