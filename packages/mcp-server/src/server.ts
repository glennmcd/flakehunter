import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApiClient, ApiClientError } from "./apiClient";

export const listFlakyTestsInput = {
  repo: z.string().min(1).describe("Repository as owner/name (e.g. acme/widgets) or its numeric id"),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Start of the window (ISO-8601); defaults to 30 days ago"),
  minRuns: z.number().int().min(1).default(5).describe("Minimum number of commits a test must have run on"),
  limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of tests to return"),
};

export const getTestFailuresInput = {
  testId: z.number().int().positive().describe("Numeric test id, as returned by list_flaky_tests"),
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

function ok(result: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

/** Only the API's own code and message reach the model; anything else gets fixed text. */
function fail(error: unknown): ToolResult {
  const text =
    error instanceof ApiClientError ? `FlakeHunter API error (${error.code}): ${error.message}` : "Unexpected error";
  return { isError: true, content: [{ type: "text", text }] };
}

export function createServer(deps: { client: ApiClient }): McpServer {
  const server = new McpServer({ name: "flakehunter", version: "0.0.1" });

  server.registerTool(
    "list_flaky_tests",
    {
      title: "List flaky tests",
      description:
        "List the flakiest tests in a repository, ranked by flake rate. A test is flaky on a commit when it both passed and failed on that same commit.",
      inputSchema: listFlakyTestsInput,
    },
    async ({ repo, since, minRuns, limit }) => {
      try {
        const { data, page } = await deps.client.getFlakyTests({ repo, since, minRuns, limit });
        return ok({ repo, tests: data, total: page.total });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_test_failures",
    {
      title: "Get test failures",
      description:
        "Get the 50 most recent failed or errored results for one test, newest first, with the failure message, commit and workflow run of each.",
      inputSchema: getTestFailuresInput,
    },
    async ({ testId }) => {
      try {
        const { test, data } = await deps.client.getTestFailures(testId);
        return ok({ test, failures: data });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
