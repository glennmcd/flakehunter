# 0010: OpenAPI as the published contract

**Status:** Accepted

## Context

The v1 API (`/api`) had Zod schemas but no document a caller, or another tool, could read. The next piece of work (Airflow)
needs a stable description of the upload and read endpoints, and the MCP server's tools mirror two of them.

## Decision

- **The contract is an OpenAPI 3.1 document generated from the route schemas** with `@fastify/swagger` and
  `fastify-type-provider-zod`'s `jsonSchemaTransform`. Validation and the spec share the Zod schemas in
  `packages/shared-types`, so they cannot drift. Only routes with a `tags` entry are published, which leaves the week-1
  routes and the webhook out. The raw XML body of `POST /api/reports`, which has no Zod schema, is described in
  `plugins/openapi.ts`.
- **It is committed as `docs/openapi.json`.** `bun run openapi:generate` rewrites it; `bun run openapi:check` fails when
  it differs from what the routes produce. The check runs inside `bun run test`, so CI fails on any drift.
- **`GET /openapi.json` and `GET /docs` are public.** They describe the contract and contain no data; every other route
  keeps its token. `/docs` is a small page that loads Swagger UI from a pinned jsDelivr release. `@fastify/swagger-ui` was
  not used: it serves its assets from disk, which the esbuild Lambda bundle does not contain.
- **Versioning is by path.** `/api` is v1. Adding fields, endpoints or optional parameters is compatible and bumps the
  minor of `info.version` (kept as a constant in `plugins/openapi.ts`, not the app version, so release-please releases do
  not stale the spec). A breaking change is served under a new prefix (`/api/v2`) next to the old one.

## Consequences

- Changing a route means regenerating and committing `docs/openapi.json`; a forgotten regeneration fails CI.
- `info.version` is bumped by hand when the contract changes.
- A test in `packages/mcp-server` checks the two tool inputs against the committed spec.
- Swagger UI needs the visitor's browser to reach jsDelivr; the spec itself does not.
