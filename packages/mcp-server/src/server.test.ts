import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server";

async function connect() {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

describe("flakehunter MCP server", () => {
  it("advertises the list_flaky_tests tool", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_flaky_tests"]);
    } finally {
      await close();
    }
  });

  it("returns an empty list from the stub", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: { repo: "acme/widgets" } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({ repo: "acme/widgets", tests: [] });
    } finally {
      await close();
    }
  });

  it("rejects a call without a repo", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: {} }).catch(() => ({ isError: true }));
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
