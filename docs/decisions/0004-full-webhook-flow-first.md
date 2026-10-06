# 0004: Build the full webhook flow first

**Status:** Accepted (Part 1)

## Context

Ingestion from GitHub is the critical path: a webhook, a signature check, listing and downloading the run's artifact,
unzipping and parsing it. It depends on GitHub configuration outside the code, which is the likeliest place for the
schedule to slip.

## Decision

Build the real flow end to end in Part 1 rather than a stub. Use a plain repository webhook with a shared secret and a
personal access token (the planned fallback) instead of a GitHub App, and handle only `workflow_run` `completed`
events with one artifact per run.

## Consequences

- The risky integration was proven early; a stub would have hidden problems and might have been thrown away.
- Processing runs inside the request. That suits small demo artifacts, but GitHub expects an answer within 10 seconds;
  a queue (SQS) is the follow-up for larger ones.
- Artifacts are untrusted input: only runs of the repo's own code are ingested, and zips are size-limited while
  streaming.
