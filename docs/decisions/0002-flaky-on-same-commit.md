# 0002: Flaky means a pass and a fail on the same commit

**Status:** Accepted (Part 1; flake rate added in Part 2)

## Context

A test that fails is not necessarily flaky: the code may simply be broken. FlakeHunter needs a definition that
separates "same code, different result" from real failures, and a way to rank tests by how flaky they are.

## Decision

A test is flaky on a commit when it has at least one pass and at least one failure or error on that commit SHA,
regardless of which workflow or job produced the results. Skipped results are ignored. Flake rate is the number of
flaky SHAs divided by the number of SHAs the test ran on.

## Consequences

- A commit SHA is effectively immutable, so the signal is reliable; workflow and job names change too often to be
  part of the key.
- A flake surfaces only when a test runs more than once on a commit: a re-run, another workflow or job, or an
  in-suite retry. A test that runs once per commit never shows as flaky.
- `perShaCte` in `apps/api/src/flaky/flakeRateQueries.ts` is the single definition for the ranking and the summary;
  the older `flaky_tests` view backs the Part 1 routes.
- `repo_id` and `head_sha` are copied onto `test_results` so the query needs no joins.
