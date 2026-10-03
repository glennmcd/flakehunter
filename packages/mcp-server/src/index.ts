import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiClient } from "./apiClient";
import { loadEnv } from "./env";
import { createServer } from "./server";

// stdout carries the MCP protocol, so problems go to stderr.
let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid environment");
  process.exit(1);
}

await createServer({ client: createApiClient(env) }).connect(new StdioServerTransport());
