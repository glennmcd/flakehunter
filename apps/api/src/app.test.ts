import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { seedRepo } from "../test/fixtures.js";
import { createTestDb } from "../test/testDb.js";
import { buildApp } from "./app.js";
import { mintRepoToken } from "./auth/repoToken.js";

const API_TOKEN = "test-global-api-token";
const SHA = "c".repeat(40);

const PASSING = `<testsuite name="S"><testcase classname="pkg.Foo" name="maybe flaky" time="0.2"/></testsuite>`;
const FAILING = `<testsuite name="S"><testcase classname="pkg.Foo" name="maybe flaky"><failure message="boom">stack</failure></testcase></testsuite>`;

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = API_TOKEN;
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
});
afterAll(() => {
  process.env = saved;
});

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  const app = await buildApp({ db, logger: false });
  const read = { authorization: `Bearer ${API_TOKEN}` };
  const upload = (runId: number, xml: string, who = token) =>
    app.inject({
      method: "POST",
      url: "/api/reports",
      headers: {
        authorization: `Bearer ${who}`,
        "content-type": "application/xml",
        "x-fh-run-id": String(runId),
        "x-fh-sha": SHA,
      },
      payload: xml,
    });
  return { db, close, repo, token, app, read, upload };
}

describe("v1 API, wired through buildApp", () => {
  it("surfaces a test as flaky after a pass and a fail upload on the same commit", async () => {
    const { close, repo, app, read, upload } = await setup();
    try {
      expect((await upload(1, PASSING)).statusCode).toBe(201);
      expect((await upload(2, FAILING)).statusCode).toBe(201);
      // Re-uploading a run does not double count.
      const again = await upload(2, FAILING);
      expect(again.statusCode).toBe(200);
      expect(again.json().duplicate).toBe(true);

      const flaky = await app.inject({
        method: "GET",
        url: "/api/tests/flaky?repo=acme/widgets&minRuns=1",
        headers: read,
      });
      expect(flaky.statusCode).toBe(200);
      const [item] = flaky.json().data;
      expect(flaky.json().page.total).toBe(1);
      expect(item).toMatchObject({ name: "maybe flaky", shasRun: 1, flakyShas: 1, flakeRate: 1 });

      const summary = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary`, headers: read });
      expect(summary.json().totals).toEqual({
        runs: 2,
        tests: 1,
        results: 2,
        passRate: 0.5,
        flakyTests: 1,
        flakyShas: 1,
      });

      const history = await app.inject({ method: "GET", url: `/api/tests/${item.testId}/history`, headers: read });
      expect(history.json().page.total).toBe(2);
      expect(
        history
          .json()
          .data.map((d: { status: string }) => d.status)
          .sort(),
      ).toEqual(["failed", "passed"]);

      // The week-1 view-backed route sees the same data.
      const legacy = await app.inject({ method: "GET", url: `/repos/${repo.id}/flaky-tests`, headers: read });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("keeps read and upload credentials separate", async () => {
    const { close, token, app, read, upload } = await setup();
    try {
      // Reads need the global token; a repo upload token is not accepted.
      const noAuth = await app.inject({ method: "GET", url: "/api/tests/flaky?repo=1" });
      expect(noAuth.statusCode).toBe(401);
      expect(noAuth.json().error.code).toBe("unauthorized");
      const repoTokenRead = await app.inject({
        method: "GET",
        url: "/api/tests/flaky?repo=1",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(repoTokenRead.statusCode).toBe(401);

      // Uploads need a repo token; the global token is not accepted.
      expect((await upload(1, PASSING, API_TOKEN)).statusCode).toBe(401);
      expect((await upload(1, PASSING, "fh_unknown")).statusCode).toBe(401);

      expect((await app.inject({ method: "GET", url: "/api/tests/flaky?repo=1", headers: read })).statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("leaves public and week-1 routes working with their original behaviour", async () => {
    const { close, app, read } = await setup();
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

      const repos = await app.inject({ method: "GET", url: "/repos", headers: read });
      expect(repos.statusCode).toBe(200);
      expect(repos.json()).toHaveLength(1);

      const legacyBad = await app.inject({ method: "GET", url: "/repos/abc/flaky-tests", headers: read });
      expect(legacyBad.statusCode).toBe(400);
      expect(legacyBad.json<unknown>()).toEqual({ error: "invalid repo id" });
    } finally {
      await close();
    }
  });

  it("returns the standard error body for validation errors and unknown routes", async () => {
    const { close, app, read } = await setup();
    try {
      const bad = await app.inject({ method: "GET", url: "/api/tests/flaky", headers: read });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe("validation_error");
      expect(bad.json().requestId).toBeTruthy();

      const missing = await app.inject({ method: "GET", url: "/api/repos/999/summary", headers: read });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("not_found");
    } finally {
      await close();
    }
  });
});
