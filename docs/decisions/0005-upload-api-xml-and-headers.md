# 0005: Upload API takes raw XML with metadata in headers

**Status:** Accepted (Part 2)

## Context

CI should be able to push a report directly, without the webhook. JUnit XML carries no commit SHA, run id or attempt,
but flaky detection needs the SHA and idempotency needs the run id.

## Decision

`POST /api/reports` takes the JUnit XML file as the raw request body, with the metadata in headers (`X-FH-Run-Id`,
`X-FH-Sha`, optional `X-FH-Run-Attempt`, `X-FH-Report-Key` and others). Uploading the same run, attempt and report key
again is a no-op that returns `200` with the original counts; a first upload returns `201`.

## Consequences

- CI needs one `curl` step and no JSON wrapping or multipart encoding.
- Retries are safe: idempotency is the `reports` table, unique on run and report key.
- Large reports must be gzip-compressed on AWS, where Lambda caps request bodies near 6 MB; the 11 MB limit applies
  after decompression.
