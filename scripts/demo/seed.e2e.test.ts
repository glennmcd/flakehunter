import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildApp } from "../../apps/api/src/app.js";
import { mintRepoToken } from "../../apps/api/src/auth/repoToken.js";
import { type ParsedSuite, parseJunitXml } from "../../apps/api/src/ingest/junitParser.js";
import { seedRepo } from "../../apps/api/test/fixtures.js";
import { createTestDb } from "../../apps/api/test/testDb.js";
import { DEMO_TESTS, type DemoTest, testKey } from "./catalog.js";
import { DEFAULT_DEMO_SEED, generateDemoRuns } from "./generateRuns.js";
import { seedDemo, type UploadRequest, type UploadResponse, uploadHeaders } from "./seedDemo.js";

// The real thing end to end: generated runs go through POST /api/reports into a PGlite database, and the read
// endpoints must agree with what the generator says it produced.

const API_TOKEN = "test-global-api-token";
const DAY = 24 * 60 * 60 * 1000;

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = API_TOKEN;
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
});
afterAll(() => {
  process.env = saved;
});

type Status = "passed" | "failed" | "error" | "skipped";

function cases(xml: string) {
  return parseJunitXml(xml).flatMap((s: ParsedSuite) => s.testCases);
}

describe("seeding the demo through the real ingestion path", () => {
  it("makes the planned tests flaky, leaves the rest alone, and re-seeding is a no-op", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db, { githubRepoId: 4242, owner: "flakehunter-demo", name: "storefront" });
      const { token } = await mintRepoToken(db, repo.id);
      const app = await buildApp({ db, logger: false, rateLimit: { max: 1_000_000 } });
      const read = { authorization: `Bearer ${API_TOKEN}` };

      const upload = async (req: UploadRequest): Promise<UploadResponse> => {
        const res = await app.inject({
          method: "POST",
          url: "/api/reports",
          headers: uploadHeaders(req, token),
          payload: req.xml,
        });
        return { status: res.statusCode, body: res.body };
      };

      const now = new Date();
      const runs = generateDemoRuns({ seed: DEFAULT_DEMO_SEED, days: 30, now });
      const totalReports = runs.reduce((sum, r) => sum + r.reports.length, 0);

      // First seed: everything is new.
      const first = await seedDemo(runs, upload);
      expect(first).toEqual({ uploads: totalReports, created: totalReports, duplicates: 0, retries: 0 });

      // What the generator says it produced, using the same definition of flaky as the API.
      const perSha = new Map<string, Map<string, Set<Status>>>();
      let results = 0;
      let passed = 0;
      let failed = 0;
      for (const run of runs) {
        const tests = perSha.get(run.headSha) ?? new Map<string, Set<Status>>();
        for (const report of run.reports) {
          for (const c of cases(report.xml)) {
            results++;
            if (c.status === "passed") passed++;
            if (c.status === "failed" || c.status === "error") failed++;
            const statuses = tests.get(testKey(c)) ?? new Set<Status>();
            statuses.add(c.status);
            tests.set(testKey(c), statuses);
          }
        }
        perSha.set(run.headSha, tests);
      }
      const expectedFlakyShas = new Map<string, number>();
      for (const tests of perSha.values()) {
        for (const [key, statuses] of tests) {
          if (statuses.has("passed") && (statuses.has("failed") || statuses.has("error"))) {
            expectedFlakyShas.set(key, (expectedFlakyShas.get(key) ?? 0) + 1);
          }
        }
      }

      const since = encodeURIComponent(new Date(now.getTime() - 35 * DAY).toISOString());

      // The ranking: exactly the six flaky tests, with the counts the generator implies.
      const ranking = await app.inject({
        method: "GET",
        url: `/api/tests/flaky?repo=${repo.id}&since=${since}&minRuns=1&limit=200`,
        headers: read,
      });
      expect(ranking.statusCode).toBe(200);
      const ranked = ranking.json().data as {
        testId: number;
        classname: string;
        name: string;
        shasRun: number;
        flakyShas: number;
        flakeRate: number;
      }[];

      const flakyTests = DEMO_TESTS.filter((t: DemoTest) => t.behaviour.type === "flaky");
      expect(ranked.map(testKey).sort()).toEqual(flakyTests.map(testKey).sort());
      for (const item of ranked) {
        expect(item.flakyShas).toBe(expectedFlakyShas.get(testKey(item)) ?? -1);
        expect(item.shasRun).toBe(perSha.size);
        expect(item.flakeRate).toBeCloseTo(item.flakyShas / item.shasRun, 10);
      }
      // Ordered by rate, and the in-suite-retry test that times out is the flakiest by design.
      const rates = ranked.map((r) => r.flakeRate);
      expect(rates).toEqual([...rates].sort((a, b) => b - a));
      expect(ranked[0]?.name).toBe("retriesOnTimeout");

      // Stable tests, the skipped ones and the fixed-but-once-broken test never appear.
      const rankedKeys = new Set(ranked.map(testKey));
      for (const test of DEMO_TESTS.filter((t) => t.behaviour.type !== "flaky")) {
        expect(rankedKeys.has(testKey(test))).toBe(false);
      }

      // The summary agrees on volume, pass rate and flaky counts.
      const summary = await app.inject({
        method: "GET",
        url: `/api/repos/${repo.id}/summary?since=${since}`,
        headers: read,
      });
      const body = summary.json();
      expect(body.totals).toEqual({
        runs: runs.length,
        tests: DEMO_TESTS.length,
        results,
        passRate: passed / (passed + failed),
        flakyTests: flakyTests.length,
        flakyShas: [...expectedFlakyShas.values()].reduce((a, b) => a + b, 0),
      });
      expect(body.lastRunAt).toBe(runs.at(-1)?.timestamp.toISOString());

      // History for the flakiest test spans weeks (the timestamps were honoured), newest first.
      const history = await app.inject({
        method: "GET",
        url: `/api/tests/${ranked[0]?.testId}/history?limit=200&since=${since}`,
        headers: read,
      });
      const times = (history.json().data as { createdAt: string }[]).map((d) => new Date(d.createdAt).getTime());
      expect(times.length).toBeGreaterThan(60);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(times[0] as number).toBeGreaterThan(now.getTime() - 2 * DAY);
      expect(times.at(-1) as number).toBeLessThan(now.getTime() - 25 * DAY);

      // Seeding again changes nothing: every upload is a duplicate and the totals are identical.
      const second = await seedDemo(runs, upload);
      expect(second).toEqual({ uploads: totalReports, created: 0, duplicates: totalReports, retries: 0 });
      const again = await app.inject({
        method: "GET",
        url: `/api/repos/${repo.id}/summary?since=${since}`,
        headers: read,
      });
      expect(again.json()).toEqual(body);
    } finally {
      await close();
    }
  }, 120_000);
});
