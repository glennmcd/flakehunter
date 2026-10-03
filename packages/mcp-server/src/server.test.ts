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

async function connect(
  getFlakyTests: ApiClient["getFlakyTests"],
  getTestFailures: ApiClient["getTestFailures"] = unusedFailures,
) {
  const server = createServer({ client: { getFlakyTests, getTestFailures } });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

const unused: ApiClient["getFlakyTests"] = async () => {
  throw new Error("should not be called");
};
const unusedFailures: ApiClient["getTestFailures"] = async () => {
  throw new Error("should not be called");
};

describe("flakehunter MCP server", () => {
  it("advertises its tools", async () => {
    const { client, close } = await connect(unused);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_flaky_tests", "get_test_failures"]);
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

  describe("get_test_failures", () => {
    const test = { id: 7, repoId: 1, classname: "pkg.Foo", name: "a test" };
    const failure = {
      resultId: 9,
      status: "failed" as const,
      headSha: "a".repeat(40),
      headBranch: "main",
      failureMessage: "boom",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { id: 1, githubRunId: 2, attempt: 1, workflowName: "CI", htmlUrl: null },
    };

    it("returns the test and its failures", async () => {
      let received: number | undefined;
      const { client, close } = await connect(unused, async (testId) => {
        received = testId;
        return { test, data: [failure] };
      });
      try {
        const res = await client.callTool({ name: "get_test_failures", arguments: { testId: 7 } });
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toEqual({ test, failures: [failure] });
        expect(received).toBe(7);
      } finally {
        await close();
      }
    });

    it("turns an API error into a tool error carrying the API code", async () => {
      const { client, close } = await connect(unused, async () => {
        throw new ApiClientError("not_found", "Test 7 not found", 404);
      });
      try {
        const res = await client.callTool({ name: "get_test_failures", arguments: { testId: 7 } });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).toContain("not_found");
      } finally {
        await close();
      }
    });

    it("rejects a missing or non-positive testId", async () => {
      const { client, close } = await connect(unused);
      try {
        for (const args of [{}, { testId: 0 }, { testId: "abc" }]) {
          const res = await client
            .callTool({ name: "get_test_failures", arguments: args })
            .catch(() => ({ isError: true }));
          expect(res.isError).toBe(true);
        }
      } finally {
        await close();
      }
    });
  });
});
