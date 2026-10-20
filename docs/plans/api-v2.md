# API v2 alongside v1

**Status:** Draft, for review. No code changes until this is agreed.

This plan serves a provider-neutral API v2 under `/api/v2`, next to the existing `/api` (v1), as
[ADR 0010](../decisions/0010-openapi-published-contract.md) requires for a breaking change. Both versions run from the
same handlers, database and tokens; they differ only in the shape of a few requests and responses. Each version has its
own committed OpenAPI document. v1 stays byte-for-byte what it is today apart from deprecation markers, and is removed
once every first-party consumer has moved.

It follows step 2 of [CI source adapters](ci-source-adapters.md), which adds `repos.host`,
`workflow_runs.ci_source` and the neutral `runId` property that v2 exposes. "Host" is where a repository's code lives
(`github`); "CI source" is the system that ran a workflow (`github_actions`). A repository has one host, and its runs
can come from several CI sources.

## What v2 changes

| | v1 (`/api`) | v2 (`/api/v2`) |
|---|---|---|
| CI run id in `run` objects | `githubRunId` | `ciRunId` |
| CI system of a run | — | `run.ciSource`: `"github_actions"` (later `"gitlab_ci"`, `"jenkins"`, …) |
| Host of a repository | — | `host` on each `GET /api/v2/repos` item |
| CI source of an upload | always the repo host's default | optional `X-FH-CI-Source` header, defaulting to the repo host's default |
| `repo` query parameter | numeric id or `owner/name` | numeric id, or a path of one or more `/`-separated segments (`group/sub/project`), optionally prefixed with a host (`github:acme/widgets`) |

The `run` objects are in the `POST /reports` 200/201 responses, `GET /tests/:id/history` and `GET /tests/:id/failures`.
`run.ciSource` is read from `workflow_runs.ci_source`, so runs of one test from different CI systems each show their
own.

**`X-FH-CI-Source`.** A CI system that uploads its own reports (a Jenkins or CircleCI step running `curl`) names
itself, so its run ids cannot collide with GitHub Actions run ids on the same repository. The value must be a known
`CiSource`; anything else is a 400 `validation_error`. Without the header, the run gets `DEFAULT_CI_SOURCE[repo.host]`,
which is what v1 always does, so a v1 upload and a v2 upload without the header for the same run are the same row.
Idempotency in v2 is on (CI source, run id, attempt, report key); the spec's description of `POST /reports` says so.

**Host-qualified paths.** Once repositories on two hosts can share a path, a bare `owner/name` can be ambiguous. v2
accepts `<host>:<path>`; a bare path still works when exactly one repository has it, and is a 400 naming the matching
hosts otherwise. v1 keeps bare `owner/name` with the same ambiguity rule, which never triggers while every repository
is on GitHub.

v1 does not expose CI sources, so a v1 history response for a repository built by two CI systems lists runs without
saying which system each came from. That is acceptable while v1 is deprecated, and is one more reason to move
consumers.

Everything else is the same in both versions: paths after the prefix, the other `X-FH-*` upload headers, error bodies,
pagination, status codes, limits and authentication. Nothing else breaking is batched into v2; a change that does not
need a new major stays out of it.

## Shape

```text
                       ┌─ /api/...     (apiVersion 1) ─┐
route plugin (one file)┤                               ├─► shared handler ─► domain functions ─► DB
                       └─ /api/v2/...  (apiVersion 2) ─┘
                            │
                            └─ schemasFor(apiVersion) picks request/response schemas and the response mapper
```

### Route registration

`RouteModule` in `routes/index.ts` gets `versions?: (1 | 2)[]`. The six files under `routes/api/` list `[1, 2]`;
`registerRoutes` registers each of them twice, at `/api` with `{ apiVersion: 1 }` and at `/api/v2` with
`{ apiVersion: 2 }`. Every file still appears once, so `routes.test.ts` keeps catching a forgotten route; its prefix
check changes to expect both mounts for `api/` files.

Each route plugin reads `opts.apiVersion` and takes its schemas from `schemasFor(apiVersion)`. Handlers stay single:
domain functions return neutral rows (`runId`, `ciSource`, `host`), and a small mapper per version turns them into the
response (`runId` → `githubRunId` with `ciSource` and `host` dropped for v1; `runId` → `ciRunId` for v2). On the way
in, the upload route passes `ingestReport` the CI source: the repo host's default for v1, the header or that default
for v2. The mappers and that one choice are the only places the two versions differ at runtime.

Plugin-level state that the routes register (`decorateRequest("repo")`, the XML content-type parsers) is per
encapsulated context, so registering a plugin twice is safe. The upload rate limit is one shared decorator and store,
so alternating between `/api/reports` and `/api/v2/reports` does not double a client's budget.

### Schemas

`packages/shared-types/src/api/v2/` holds the v2 schemas. Unchanged schemas are re-exported from v1; the changed ones
(`uploadReportHeadersSchema` with `x-fh-ci-source`, `uploadReportResponseSchema`, `testHistoryItemSchema`,
`testFailureItemSchema`, their list wrappers, the repo list item and the `repo` parameter) are defined there. The
`ciSource` and `host` enums come from the `CiSource` and `RepoHost` types in shared-types, so the spec lists exactly
the values the database accepts. `@flakehunter/shared-types` exports them as `v2.*`, and the existing
top-level exports stay v1, so nothing that imports them today changes.

### Authentication

`plugins/auth.ts` matches exempt paths exactly. `/api/v2/reports`, `/openapi.v2.json` and `/docs/v2` are added. The v2 read routes
need `API_TOKEN` like v1, and `/api/v2/reports` uses the per-repo upload token through the same hook. A test asserts
every exemption for both versions, since a missing entry would make v2 uploads fail with 401 rather than open
anything.

API Gateway's `$default` stage forwards every path to the Lambda, so `infra/` needs no change.

### Two OpenAPI documents

One `@fastify/swagger` registration still collects every route. `buildSpec.ts` builds the full document once and
splits it by path prefix:

| Document | Paths | `info.version` | Served at |
|---|---|---|---|
| `docs/openapi.json` | `/api/*` except `/api/v2/*` | 1.1.0 | `GET /openapi.json` (unchanged) |
| `docs/openapi.v2.json` | `/api/v2/*` | 2.0.0 | `GET /openapi.v2.json` |

Splitting is safe because the generated document has no `$ref`s: every schema is inlined, so each half is
self-contained. Shared `components` (the two security schemes) and `tags` are copied into both. A test asserts that
neither document contains a `$ref` to something it lacks, so the split cannot silently break if that ever changes.

`describeReportsUpload` applies to both `/api/reports` and `/api/v2/reports`. `API_CONTRACT_VERSION` becomes one
constant per version.

Each version has its own docs page: `/docs` stays the v1 page, unchanged, and `/docs/v2` loads `/openapi.v2.json`.
Both come from one page template that takes the spec URL and title. When v1 is deprecated, the `/docs` page shows a
line linking to `/docs/v2`. When v1 is removed, `/docs` serves v2.

`scripts/openapi.ts` writes and checks both files, so `openapi:check` in `bun run test` catches drift in either.

### Deprecating v1

- In `docs/openapi.json`, every operation gets `deprecated: true` and the description points at v2. Marking an
  operation deprecated is a compatible change, hence 1.1.0.
- v1 responses carry a `Deprecation` header from step 3 on, when v1 is formally deprecated, and not before. Step 1
  mounts v2 without deprecating anything, so v1 clients see no new headers until v2 is complete and they have
  something to move to.
  - **Which responses:** every response from an `apiVersion: 1` route, errors and 429s included, because a client
    that only ever sees errors still needs the signal. Not on `/api/v2`, `/health`, `/webhooks/github`, the week-1 root
    routes, `/openapi.json` or the docs pages, which are not v1 API operations.
  - **Value:** the RFC 9745 form, `Deprecation: @<unix seconds>`, the moment v1 was deprecated, kept as one constant
    (`V1_DEPRECATED_AT`) set in step 3. RFC 9745 defines the header as a date; the bare `Deprecation: true` from its
    earlier drafts is not valid under the final RFC, and a strict client may ignore it.
  - **With it:** `Link: </openapi.v2.json>; rel="successor-version"` and `Link: </docs/v2>; rel="deprecation"`, so a
    client can find the replacement.
  - **Where:** one `onSend` hook added in the `apiVersion: 1` registrations, so it cannot leak onto other routes. A
    `Sunset` header is added only once a removal date is chosen.
  - The headers are declared on every v1 operation in `docs/openapi.json`, so the spec describes what is sent.
- The regression check for v1: after this change, the diff to `docs/openapi.json` is the `deprecated` flags, the
  description note and `info.version`, nothing else.

## Steps

Each step is one commit and leaves `bun run lint && bun run typecheck && bun run test` green.

1. **Dual mounting, identical schemas.** `versions` in `RouteModule`, `apiVersion` in every `/api` plugin, both
   mounts registered, auth exemptions, the spec split into two documents and the `/docs/v2` page. v2 still uses the v1
   schemas, so `docs/openapi.v2.json` is v1 with `/api/v2` paths. This isolates the plumbing from the contract change.
2. **v2 contract.** The `v2` schemas in shared-types, the per-version mappers, `X-FH-CI-Source` on `/api/v2/reports`,
   nested and host-qualified `repo` paths in `resolveRepo` for v2, and `info.version` 2.0.0. Route tests run once per
   version (`describe.each`), with v2-specific cases for `ciRunId`, `ciSource`, `host`, the header and repo paths.
3. **Deprecate v1.** `deprecated` flags, the description note, `V1_DEPRECATED_AT`, the `Deprecation` and `Link`
   headers, the `/docs` link to `/docs/v2`, `info.version` 1.1.0.
4. **Move first-party consumers to v2.**
   - `apps/web`: `lib/api.ts` uses `/api/v2` and the v2 schemas; `TestDetail.tsx` reads `ciRunId`.
   - `packages/mcp-server`: tools call `/api/v2`; `server.test.ts` checks tool inputs against `docs/openapi.v2.json`.
   - flakehunter-airflow (that repo, its own commit): `pin_spec.py` and `check_drift.py` point at
     `docs/openapi.v2.json`, the client is regenerated and uploads go to `/api/v2/reports`. The GitHub DAG can omit
     `X-FH-CI-Source` (the default is `github_actions`); the GitLab DAG sends `gitlab_ci` once that value exists.
5. **Docs.** ADR 0012 "API v2 alongside v1" (two documents from one app, shared handlers, the retirement rule below);
   `docs/api.md` and the CI snippet use `/api/v2/reports` and show `X-FH-CI-Source` for uploads from CI systems other
   than the host's own; the `CLAUDE.md` API section describes both versions.

Retiring v1 is step 4 of the [naming cleanup](ci-source-adapters.md#naming-cleanup): once step 4 here has landed in
all three consumers, the `/api` mounts, `docs/openapi.json` and the v1 mappers are removed.

## Validation

- **Both versions, every route:** route tests parameterized over `/api` and `/api/v2`, plus v2-only cases.
- **Shared state:** uploading a run through `/api/reports` and then the same run through `/api/v2/reports` returns 201
  then 200 duplicate with the same counts, and the reverse; the rate limit counts both paths together.
- **CI source:** a v2 upload without `X-FH-CI-Source`, one with `github_actions`, and a v1 upload of the same run are
  one row; an unknown value is a 400; `run.ciSource` in v2 history shows each run's own source. While
  `github_actions` is the only value, "same run id, different CI source is a separate run" is covered at the database
  level in [CI source adapters](ci-source-adapters.md#validation); the API-level case is added with the second value.
- **Repo paths:** v2 resolves `group/sub/project` and `github:acme/widgets`; a bare path matching two hosts is a 400
  naming both; an unknown host prefix is a 400.
- **Auth:** each v2 read route returns 401 without `API_TOKEN`; `/api/v2/reports` rejects `API_TOKEN` and accepts an
  upload token; `/docs/v2` and `/openapi.v2.json` need no token.
- **Deprecation header:** before step 3, no response has it. After step 3, every v1 route sends `Deprecation` and both
  `Link`s on success, on a 401, on a 422 and on a 429; no v2 route, `/health`, `/webhooks/github`, week-1 route, spec or
  docs page sends it.
- **Contract:** `openapi:check` for both documents; the v1 diff check above; the `$ref` check; the MCP server's spec
  test against v2.
- **Manual:** `bun run dev:api`, then `/docs` shows v1 and `/docs/v2` shows v2, `curl -i` on a v1 route shows the
  `Deprecation` header, and one upload through each path appears once in the dashboard.

## Not in scope

- Any v2 change beyond the table above, such as new endpoints or a different error body.
- A removal date for v1 (`Sunset`); the retirement rule is "after all first-party consumers move".
- The week-1 root routes (`/repos/:id/flaky-tests` and others) and `/webhooks/github`, which are not part of the
  published contract.
- Database changes; those are in [CI source adapters](ci-source-adapters.md).
