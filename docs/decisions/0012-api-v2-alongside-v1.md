# 0012: API v2 alongside v1

**Status:** Accepted ([API v2 alongside v1](../plans/api-v2.md)). v1 was retired on 2026-10-20 under the rule below:
the `/api` mounts, `api/v1.ts`, the v1 schemas and `docs/openapi.json` are gone, `/openapi.json` is a 404 and `/docs`
redirects to `/docs/v2`.

## Context

ADR 0011 split repository hosts from CI sources, but v1 cannot show either: its `run` objects say `githubRunId`, an
upload cannot name its CI system and `repo` is a bare `owner/name`. Fixing that breaks the contract, and ADR 0010 says a
breaking change goes under a new prefix next to the old one. The dashboard, the MCP server and flakehunter-airflow all
call v1.

## Decision

- **One app serves both.** Each file in `routes/api/` is registered twice by `registerApiVersion`, at `/api` and
  `/api/v2`, with `{ apiVersion }`. Handlers, database, tokens, rate limit and error bodies are shared; domain functions
  return the neutral shape (`ciRunId`, `ciSource`, `host`) and the v1 mappers in `api/v1.ts` turn it back into v1.
- **v2 changes only:** `ciRunId` and `ciSource` on runs, `host` on repos, the optional `X-FH-CI-Source` upload header
  (default `DEFAULT_CI_SOURCE[repo.host]`, as v1 always does) and `repo` as an id or `[host:]path`.
- **Two documents from one spec.** `docs/openapi.json` (v1, 1.1.0) and `docs/openapi.v2.json` (v2, 2.0.0) are split
  by path from one generated document, served at `/openapi.json` and `/openapi.v2.json`, with pages at `/docs` and
  `/docs/v2`. Each has its own `info.version`.
- **v1 is deprecated, not changed.** Its operations are marked `deprecated`, and every v1 response, errors included,
  carries `Deprecation: @<V1_DEPRECATED_AT>` and `Link`s to the v2 spec and docs.
- **Retirement rule:** v1 is removed once every first-party consumer uses v2. No `Sunset` date until then.

## Consequences

- A v1 and a v2 upload of the same run are one report, so consumers can move one at a time.
- Every published route needs both versions' tests (`describe.each` over `API_VERSIONS`) until v1 goes.
- Removing v1 deletes the `/api` mounts, `docs/openapi.json` and `api/v1.ts`; `/docs` then serves v2.
