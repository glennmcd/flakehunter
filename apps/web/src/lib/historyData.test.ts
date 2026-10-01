import { describe, expect, it } from "bun:test";
import { loadHistory } from "./historyData";

const now = new Date("2026-03-31T12:00:00.000Z");

function fakeClient(repoId = 3) {
  const calls: unknown[][] = [];
  const client = {
    getTestHistory: async (...args: unknown[]) => {
      calls.push(args);
      const params = args[1] as { limit: number };
      return {
        test: { id: 63, repoId, classname: "C", name: "n" },
        data: [],
        page: { limit: params.limit, offset: 0, total: params.limit === 200 ? 57 : 12 },
      };
    },
  };
  return { client, calls };
}

describe("loadHistory", () => {
  it("fetches an unfiltered chart set and a filtered table page for the same window", async () => {
    const { client, calls } = fakeClient();
    const result = await loadHistory(client, 3, 63, { days: 7, status: "failed", page: 2 }, now);

    const since = new Date("2026-03-24T12:00:00.000Z");
    expect(calls).toContainEqual([63, { since, limit: 200, offset: 0 }]);
    expect(calls).toContainEqual([63, { since, status: "failed", limit: 20, offset: 20 }]);
    expect(result.chart.total).toBe(57);
    expect(result.table.total).toBe(12);
    expect(result.test.name).toBe("n");
  });

  it("is not_found when the test belongs to another repository", async () => {
    const { client } = fakeClient(7);
    await expect(loadHistory(client, 3, 63, { days: 30, status: undefined, page: 1 }, now)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
