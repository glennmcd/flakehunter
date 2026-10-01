import { describe, expect, it } from "bun:test";
import { ApiClientError } from "./api";
import { loadOverview } from "./overviewData";

const now = new Date("2026-03-31T12:00:00.000Z");

function fakeClient() {
  const calls: { summary?: unknown[]; flaky?: unknown[] } = {};
  const client = {
    getRepoSummary: async (...args: unknown[]) => {
      calls.summary = args;
      return {
        repo: { id: 3, fullName: "o/r" },
        window: { since: "x" },
        totals: { runs: 1, tests: 1, results: 1, passRate: 1, flakyTests: 0, flakyShas: 0 },
        lastRunAt: null,
      };
    },
    getFlakyTests: async (...args: unknown[]) => {
      calls.flaky = args;
      return { data: [], page: { limit: 20, offset: 40, total: 57 } };
    },
  };
  return { client, calls };
}

describe("loadOverview", () => {
  it("asks both endpoints for the same window and the requested page", async () => {
    const { client, calls } = fakeClient();
    const result = await loadOverview(client, 3, { days: 7, minRuns: 2, page: 3 }, now);

    const since = new Date("2026-03-24T12:00:00.000Z");
    expect(calls.summary).toEqual([3, { since }]);
    expect(calls.flaky).toEqual([{ repo: 3, since, minRuns: 2, limit: 20, offset: 40 }]);
    expect(result.flaky.total).toBe(57);
    expect(result.summary.repo.fullName).toBe("o/r");
  });

  it("rejects with the API error when either call fails", async () => {
    const { client } = fakeClient();
    const failing = {
      ...client,
      getRepoSummary: async () => {
        throw new ApiClientError("not_found", "no such repo", 404);
      },
    };
    await expect(loadOverview(failing, 99, { days: 30, minRuns: 5, page: 1 }, now)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
