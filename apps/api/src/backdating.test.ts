import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { daysAgo, seedRepo, sha } from "../test/fixtures.js";
import { createTestDb } from "../test/testDb.js";
import { buildApp } from "./app.js";
import { mintRepoToken } from "./auth/repoToken.js";

const API_TOKEN = "test-global-api-token";

const PASSING = `<testsuite name="S"><testcase classname="pkg.Foo" name="maybe flaky"/></testsuite>`;
const FAILING = `<testsuite name="S"><testcase classname="pkg.Foo" name="maybe flaky"><failure message="boom"/></testcase></testsuite>`;

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = API_TOKEN;
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
});
afterAll(() => {
  process.env = saved;
});

describe("X-FH-Timestamp through the real app", () => {
  it("places backdated runs in the right since windows and orders history by the given times", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const { token } = await mintRepoToken(db, repo.id);
      const app = await buildApp({ db, logger: false });
      const read = { authorization: `Bearer ${API_TOKEN}` };

      const upload = (runId: number, headSha: string, xml: string, when: Date) =>
        app.inject({
          method: "POST",
          url: "/api/reports",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/xml",
            "x-fh-run-id": String(runId),
            "x-fh-sha": headSha,
            "x-fh-timestamp": when.toISOString(),
          },
          payload: xml,
        });

      // A flake 40 days ago (pass and fail on one commit) and another 3 days ago.
      const old = daysAgo(40);
      const recent = daysAgo(3);
      for (const [runId, headSha, xml, when] of [
        [1, sha(1), PASSING, old],
        [2, sha(1), FAILING, new Date(old.getTime() + 60_000)],
        [3, sha(2), PASSING, recent],
        [4, sha(2), FAILING, new Date(recent.getTime() + 60_000)],
      ] as const) {
        expect((await upload(runId, headSha, xml, when)).statusCode).toBe(201);
      }

      // Default 30 day window: only the recent commit counts.
      const narrow = await app.inject({
        method: "GET",
        url: `/api/tests/flaky?repo=${repo.id}&minRuns=1`,
        headers: read,
      });
      expect(narrow.json().data[0]).toMatchObject({ shasRun: 1, flakyShas: 1 });

      // Wider window sees both commits.
      const since = encodeURIComponent(daysAgo(60).toISOString());
      const wide = await app.inject({
        method: "GET",
        url: `/api/tests/flaky?repo=${repo.id}&minRuns=1&since=${since}`,
        headers: read,
      });
      const [item] = wide.json().data;
      expect(item).toMatchObject({ shasRun: 2, flakyShas: 2 });

      // Summary windows runs by their backdated time; lastRunAt is the newest run.
      const summaryNarrow = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary`, headers: read });
      expect(summaryNarrow.json().totals).toMatchObject({ runs: 2, results: 2, flakyShas: 1 });
      const summaryWide = await app.inject({
        method: "GET",
        url: `/api/repos/${repo.id}/summary?since=${since}`,
        headers: read,
      });
      expect(summaryWide.json().totals).toMatchObject({ runs: 4, results: 4, flakyShas: 2 });

      // History spans the weeks and is ordered by the given timestamps, newest first.
      const history = await app.inject({ method: "GET", url: `/api/tests/${item.testId}/history`, headers: read });
      const times = history.json().data.map((d: { createdAt: string }) => new Date(d.createdAt).getTime());
      expect(times).toHaveLength(4);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(times[0] - times[3]).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
    } finally {
      await close();
    }
  });
});
