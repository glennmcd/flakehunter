import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildApp } from "../../apps/api/src/app.js";
import { mintRepoToken } from "../../apps/api/src/auth/repoToken.js";
import { seedRepo } from "../../apps/api/test/fixtures.js";
import { createTestDb } from "../../apps/api/test/testDb.js";
import { DEFAULT_DEMO_SEED, generateDemoRuns } from "./generateRuns.js";
import { seedDemo, type UploadRequest, type UploadResponse, uploadHeaders } from "./seedDemo.js";

// The upload rate limit must not break seeding: the seeder waits out a 429 (using Retry-After) and carries on, so a
// seed bigger than one window still ends with every report stored exactly once.

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = "test-global-api-token";
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
});
afterAll(() => {
  process.env = saved;
});

describe("seeding against an API with a small upload rate limit", () => {
  it("waits out the 429s and stores every report once", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db, { githubRepoId: 4243, owner: "flakehunter-demo", name: "storefront" });
      const { token } = await mintRepoToken(db, repo.id);
      // 4 uploads per 1 second window; the demo history below has several times that.
      const app = await buildApp({ db, logger: false, rateLimit: { max: 4, windowSeconds: 1 } });

      const upload = async (req: UploadRequest): Promise<UploadResponse> => {
        const res = await app.inject({
          method: "POST",
          url: "/api/reports",
          headers: uploadHeaders(req, token),
          payload: req.xml,
          remoteAddress: "203.0.113.50",
        });
        const retryAfter = res.headers["retry-after"];
        return {
          status: res.statusCode,
          body: res.body,
          retryAfterSeconds: typeof retryAfter === "string" ? Number(retryAfter) : undefined,
        };
      };

      const runs = generateDemoRuns({ seed: DEFAULT_DEMO_SEED, days: 3, now: new Date() });
      const totalReports = runs.reduce((sum, run) => sum + run.reports.length, 0);
      expect(totalReports).toBeGreaterThan(8);

      const summary = await seedDemo(runs, upload);
      expect(summary.uploads).toBe(totalReports);
      expect(summary.created).toBe(totalReports);
      expect(summary.duplicates).toBe(0);
      expect(summary.retries).toBeGreaterThan(0);
    } finally {
      await close();
    }
  }, 60_000);
});
