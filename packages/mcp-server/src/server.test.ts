import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ApiClient, ApiClientError } from "./apiClient";
import { createServer } from "./server";

const item = {
  testId: 1,
  classname: "pkg.Foo",
  name: "a test",
  shasRun: 10,
  flakyShas: 2,
  flakeRate: 0.2,
  lastFlakyAt: "2026-01-01T00:00:00.000Z",
};

async function connect(getFlakyTests: ApiClient["getFlakyTests"]) {
  const server = createServer({ client: { getFlakyTests } });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

const unused: ApiClient["getFlakyTests"] = async () => {
  throw new Error("should not be called");
};

describe("flakehunter MCP server", () => {
  it("advertises the list_flaky_tests tool", async () => {
    const { client, close } = await connect(unused);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_flaky_tests"]);
    } finally {
      await close();
    }
  });

  it("returns the API's flaky tests and passes the arguments through with defaults", async () => {
    let received: unknown;
    const { client, close } = await connect(async (params) => {
      received = params;
      return { data: [item], page: { limit: 20, offset: 0, total: 7 } };
    });
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: { repo: "acme/widgets" } });

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({ repo: "acme/widgets", tests: [item], total: 7 });
      expect(received).toEqual({ repo: "acme/widgets", since: undefined, minRuns: 5, limit: 20 });
    } finally {
      await close();
    }
  });

  it("turns an API error into a tool error carrying the API's code", async () => {
    const { client, close } = await connect(async () => {
      throw new ApiClientError("not_found", "Repo not found", 404);
    });
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: { repo: "x/y" } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("not_found");
    } finally {
      await close();
    }
  });

  it("hides unexpected errors behind fixed text", async () => {
    const { client, close } = await connect(async () => {
      throw new Error("secret internals");
    });
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: { repo: "x/y" } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).not.toContain("secret internals");
    } finally {
      await close();
    }
  });

  it("rejects a call without a repo", async () => {
    const { client, close } = await connect(unused);
    try {
      const res = await client.callTool({ name: "list_flaky_tests", arguments: {} }).catch(() => ({ isError: true }));
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
