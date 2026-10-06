# Part 2: The v1 REST API

An `/api` surface for uploading reports from CI and reading flaky-test data.

## Prompt

> Read docs/plans/[part-1-ingestion].md and the current code. Plan the v1 REST API:
> - POST /api/reports: upload a JUnit XML report. Auth with a per-repo API
>   token. Idempotent on repo + CI run id, so re-uploads don't double count.
> - GET /api/tests/flaky?repo=&since= : tests ranked by flake rate
> - GET /api/tests/:id/history : pass/fail history for one test
> - GET /api/repos/:id/summary : totals for the dashboard
>
> Propose Zod request/response schemas, one error format, pagination and
> status codes. Ask me about anything ambiguous before finalizing.

## Questions settled before building

| Question | Answer |
| --- | --- |
| JUnit XML has no commit SHA, run id or attempt. How does `POST /api/reports` get them? | Raw XML body, metadata in headers |
| What happens when the same repo and CI run are uploaded again? (The webhook path had no guard and double counted.) | No-op, return 200 |
| How is flake rate defined for ranking? | Flaky SHAs divided by SHAs run |
| How are reads authenticated and repos addressed? | One global token for reads, a per-repo token for uploads |

## Plan

- `POST /api/reports`: raw XML (`application/xml`), metadata in `X-FH-*` headers, per-repo token checked before the
  body is parsed, idempotent through a `reports` table unique on run and report key.
- Read endpoints: flaky ranking (`perShaCte`, the single definition of a flaky SHA), test history and repo summary.
- Zod schemas for every request and response in `packages/shared-types`; one error body
  (`{ error: { code, message, details? }, requestId }`); `?limit=&offset=` pagination.

## Outcome

Shipped as planned. The webhook path now records a `reports` row too, so redeliveries and an upload plus a webhook for
the same run never double count. Later parts added `GET /api/repos` and the `X-FH-Timestamp` backdating header (Part 3), gzip
uploads and rate limiting (Part 4), and `GET /api/tests/:id/failures` for the MCP server. The reference is
[../api.md](../api.md).

## Decisions

- [0002: Flaky means a pass and a fail on the same commit](../decisions/0002-flaky-on-same-commit.md) (flake rate)
- [0005: Upload API takes raw XML with metadata in headers](../decisions/0005-upload-api-xml-and-headers.md)
- [0006: One read token, per-repo upload tokens](../decisions/0006-read-token-and-upload-tokens.md)
