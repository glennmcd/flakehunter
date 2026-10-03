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
        const result = { repo, tests: data, total: page.total };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        // Only the API's own code and message reach the model; anything else gets fixed text.
        const text =
          error instanceof ApiClientError
            ? `FlakeHunter API error (${error.code}): ${error.message}`
            : "Unexpected error";
        return { isError: true, content: [{ type: "text", text }] };
      }
    },
  );

  return server;
}
