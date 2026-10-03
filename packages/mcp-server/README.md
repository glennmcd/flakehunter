# @flakehunter/mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant query FlakeHunter: which tests are flaky in a repo, and how a given test has failed. It talks to the FlakeHunter API over HTTP and uses stdio as its transport.

It is read-only. It calls the same `/api` endpoints as the dashboard, with the API's read token.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_flaky_tests` | `repo` (owner/name or numeric id), `since` (ISO-8601, default 30 days ago), `minRuns` (default 5), `limit` (1-200, default 20) | `{ repo, tests, total }`. Tests are ranked by flake rate, each with `testId`, `classname`, `name`, `shasRun`, `flakyShas`, `flakeRate`, `lastFlakyAt`. |
| `get_test_failures` | `testId` (from `list_flaky_tests`) | `{ test, failures }`: the 50 most recent failed or errored results, newest first, each with its message, commit, branch and workflow run. |

A test is flaky on a commit when it both passed and failed on that same commit. API errors come back as tool errors that carry the API's error code, for example `FlakeHunter API error (not_found): Test 999999 not found`. Anything unexpected is reported as `Unexpected error`; no stack traces, URLs or tokens reach the model.

## Configuration

| Variable | Meaning |
|---|---|
| `API_BASE_URL` | Base URL of the FlakeHunter API, `http` or `https` (for example `http://localhost:3000`) |
| `API_TOKEN` | The API's read token (`API_TOKEN` in `apps/api/.env`) |

The server exits with a message on stderr if either is missing or invalid. The message names the variable, never its value.

## Run it

From the repo root, with the API running (`bun run dev:api`):

```bash
API_BASE_URL=http://localhost:3000 API_TOKEN=<token> bun run --cwd packages/mcp-server start
```

To use it from Claude Code, register it with absolute paths so it works from any directory:

```bash
claude mcp add flakehunter --env API_BASE_URL=http://localhost:3000 --env API_TOKEN=<token> -- bun run --cwd <path to repo>/packages/mcp-server start
```

The server speaks MCP on stdout, so it never logs there. Diagnostics go to stderr.

## Develop

```bash
bun test packages/mcp-server                       # unit tests
bunx tsc --noEmit -p packages/mcp-server/tsconfig.json
```

The root `bun run lint`, `typecheck` and `test` cover this package too.

- `src/server.ts`: `createServer({ client })` registers the tools. The client is injected so tests can fake it.
- `src/apiClient.ts`: a small fetch client. It validates every response against the Zod schemas in `@flakehunter/shared-types`, so a change in the API's response shape fails loudly instead of returning wrong data.
- `src/env.ts`: environment loading.
- `src/index.ts`: the stdio entry point.

Tests run the real server against an SDK client over an in-memory transport, with a fake `fetch` or a fake API client. They need no network and no database.

To add a tool, add a method to the client in `apiClient.ts` (with a test), register the tool in `server.ts` with its Zod input, and add tests next to the existing ones in `server.test.ts`.
