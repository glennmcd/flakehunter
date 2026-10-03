import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const listFlakyTestsInput = {
  repo: z.string().min(1).describe("Repository as owner/name, e.g. acme/widgets"),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Start of the window (ISO-8601); defaults to 30 days ago"),
  minRuns: z.number().int().min(1).default(5).describe("Minimum number of commits a test must have run on"),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "flakehunter", version: "0.0.1" });

  server.registerTool(
    "list_flaky_tests",
    {
      title: "List flaky tests",
      description: "List the flakiest tests in a repository, ranked by flake rate (flaky commits / commits run).",
      inputSchema: listFlakyTestsInput,
    },
    async ({ repo }) => {
      // Stub: will call GET /api/tests/flaky once the API client exists.
      const result = { repo, tests: [] as unknown[] };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  return server;
}
