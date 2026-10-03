---
description: Add a new read endpoint under /api in the FlakeHunter Fastify API, test-first, following the existing route, schema and registration conventions. Use when asked to add, expose or build an API route.
argument-hint: [endpoint description]
---

# New /api endpoint

Endpoint to add: $ARGUMENTS

Model it on `apps/api/src/routes/api/repoSummary.ts` (params + query + handler) and `repos.ts` (paginated list). Don't skip steps; run each command before moving on.

## 0. Align first
State the method and path (written after `/api`, e.g. `/repos/:id/summary`), the query params, the response shape, and which errors it can return. Wait for approval. Read endpoints use the global `API_TOKEN` and need no auth change. A public route must also be added to the exemption in `apps/api/src/plugins/auth.ts`.

## 1. Schemas (`packages/shared-types/src/api/`)
- Add Zod request and response schemas to the matching file (`repos.ts`, `tests.ts`, or a new file re-exported from `index.ts`). Reuse `idParamSchema`, `paginationQuerySchema` and `pageSchema` from `common.ts`.
- Imports inside this package are **extensionless** (`from "./common"`), never `.js`.
- Lists take `?limit=&offset=` and return `{ data, page: { limit, offset, total } }`. Timestamps are ISO strings; use `z.iso.datetime({ offset: true })` for `since`.
- Add parse/reject cases to `schemas.test.ts` for any non-trivial schema.

## 2. Failing test first (`apps/api/src/routes/api/<name>.test.ts`)
- Copy the setup from `repoSummary.test.ts`: `createTestDb()` (in-memory PGlite), `seedRepo`/`seedRun`/`seedResult`/`daysAgo`/`sha` from `test/fixtures.ts`, `buildApiApp(db, [route])` from `test/apiApp.ts`, then `app.inject(...)`. Always `close()` the db in `finally`.
- Cover: the happy path with exact values, the window or filter params, an empty repo, other repos' data being ignored, `404 not_found` for an unknown id, `400 validation_error` for bad input.
- Use `res.json<unknown>()` when passing a body straight to `toEqual`.
- Run `bun test apps/api/src/routes/api/<name>.test.ts` and confirm it fails for the right reason.

## 3. Query function (domain layer, not the route)
- Put the logic in a module beside the feature (`summary/`, `history/`, `flaky/`, `repos/`), taking `AnyDb` from `db/client.ts`, not the postgres-js `Db`.
- Use the Drizzle query builder (including `$with` CTEs); raw `db.execute` returns different shapes on PGlite and postgres-js. Reuse `perShaCte` for anything about flaky SHAs. Never return `failureStack`.
- Give it its own unit test next to it (`<name>Queries.test.ts`).

## 4. Route (`apps/api/src/routes/api/<name>.ts`)
- Default-export a `FastifyPluginAsync`; use `fastify.withTypeProvider<ZodTypeProvider>()` and put `params`, `querystring` and `response: { 200: ... }` in the route `schema`.
- Register the path after `/api` only (`"/repos/:id/summary"`), never the full path. Keep the file flat in `routes/api/`.
- Resolve the repo with `resolveRepo(fastify.db, { id })` (404 for free). Throw `ApiError` (`api/errors.ts`) for other failures; the body is always `{ error: { code, message, details? }, requestId }`.
- Relative imports in the API use the `.js` suffix.

## 5. Register
Add the import and a `{ file: "api/<name>", plugin, prefix: "/api" }` entry to `routeModules` in `apps/api/src/routes/index.ts`. There is no autoload; `routes.test.ts` fails if a file is missing.

## 6. Verify
```bash
bun run lint && bun run typecheck && bun run test
```
Fix with `bun run lint:fix`. If the web app will call it, export the response type from shared-types and add a helper in `apps/web/lib/`.

## 7. Docs
`docs/api.md` does not exist yet. Document the endpoint in the "Read endpoints" list in `CLAUDE.md` (and `README.md` if user-facing). Don't commit; the user does that.
