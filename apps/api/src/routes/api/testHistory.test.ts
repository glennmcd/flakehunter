import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { daysAgo, seedRepo, seedResult, sha } from "../../../test/fixtures.js";
import { createTestDb } from "../../../test/testDb.js";
import testHistoryRoute from "./testHistory.js";

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const app = await buildApiApp(db, [testHistoryRoute]);
  return { db, close, repo, app };
}

describe("GET /api/tests/:id/history", () => {
  it("returns the test and its results newest first with run details", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const oldest = await seedResult(db, repo.id, { status: "passed", headSha: sha(1), createdAt: daysAgo(3) });
      await seedResult(db, repo.id, {
        status: "failed",
        headSha: sha(2),
        createdAt: daysAgo(2),
        durationSeconds: 1.5,
        failureMessage: "boom",
      });
      await seedResult(db, repo.id, { status: "passed", headSha: sha(3), createdAt: daysAgo(1) });

      const res = await app.inject({ method: "GET", url: `/api/tests/${oldest.testCase.id}/history` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.test).toEqual({ id: oldest.testCase.id, repoId: repo.id, classname: "pkg.Foo", name: "a test" });
      expect(body.page).toEqual({ limit: 50, offset: 0, total: 3 });
      expect(body.data.map((d: { headSha: string }) => d.headSha)).toEqual([sha(3), sha(2), sha(1)]);
      expect(body.data[1]).toEqual({
        resultId: expect.any(Number),
        status: "failed",
        headSha: sha(2),
        headBranch: "main",
        occurrenceIndex: 0,
        durationSeconds: 1.5,
        failureMessage: "boom",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        run: {
          id: expect.any(Number),
          githubRunId: expect.any(Number),
          attempt: 1,
          workflowName: "CI",
          htmlUrl: null,
        },
      });
      expect(body.data[0].durationSeconds).toBeNull();
      expect(body.data[0].failureMessage).toBeNull();
    } finally {
      await close();
    }
  });

  it("does not include failure stacks or results of other tests", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const mine = await seedResult(db, repo.id, {
        status: "failed",
        headSha: sha(1),
        failureStack: "at secret.stack.frame (file.ts:1)",
      });
      await seedResult(db, repo.id, { name: "other test", status: "passed", headSha: sha(1) });

      const res = await app.inject({ method: "GET", url: `/api/tests/${mine.testCase.id}/history` });

      expect(res.json().page.total).toBe(1);
      expect(res.body).not.toContain("secret.stack.frame");
      expect(res.body).not.toContain("failureStack");
    } finally {
      await close();
    }
  });

  it("filters by status and since", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const first = await seedResult(db, repo.id, { status: "failed", headSha: sha(1), createdAt: daysAgo(20) });
      await seedResult(db, repo.id, { status: "passed", headSha: sha(2), createdAt: daysAgo(5) });
      await seedResult(db, repo.id, { status: "failed", headSha: sha(3), createdAt: daysAgo(2) });
      await seedResult(db, repo.id, { status: "error", headSha: sha(4), createdAt: daysAgo(1) });
      const base = `/api/tests/${first.testCase.id}/history`;

      const failed = await app.inject({ method: "GET", url: `${base}?status=failed` });
      expect(failed.json().data.map((d: { headSha: string }) => d.headSha)).toEqual([sha(3), sha(1)]);
      expect(failed.json().page.total).toBe(2);

      const since = encodeURIComponent(daysAgo(10).toISOString());
      const recent = await app.inject({ method: "GET", url: `${base}?since=${since}` });
      expect(recent.json().page.total).toBe(3);

      const both = await app.inject({ method: "GET", url: `${base}?since=${since}&status=failed` });
      expect(both.json().data.map((d: { headSha: string }) => d.headSha)).toEqual([sha(3)]);
    } finally {
      await close();
    }
  });

  it("paginates with a total that ignores limit and offset", async () => {
    const { db, close, repo, app } = await setup();
    try {
      let testId = 0;
      for (let n = 1; n <= 5; n++) {
        const seeded = await seedResult(db, repo.id, { status: "passed", headSha: sha(n), createdAt: daysAgo(10 - n) });
        testId = seeded.testCase.id;
      }
      const base = `/api/tests/${testId}/history`;

      const page2 = await app.inject({ method: "GET", url: `${base}?limit=2&offset=2` });
      expect(page2.json().page).toEqual({ limit: 2, offset: 2, total: 5 });
      expect(page2.json().data.map((d: { headSha: string }) => d.headSha)).toEqual([sha(3), sha(2)]);

      const beyond = await app.inject({ method: "GET", url: `${base}?limit=2&offset=50` });
      expect(beyond.json().data).toEqual([]);
      expect(beyond.json().page.total).toBe(5);
    } finally {
      await close();
    }
  });

  it("returns 200 with an empty list when the filters match nothing", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const seeded = await seedResult(db, repo.id, { status: "passed", headSha: sha(1) });
      const res = await app.inject({ method: "GET", url: `/api/tests/${seeded.testCase.id}/history?status=error` });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().test.id).toBe(seeded.testCase.id);
    } finally {
      await close();
    }
  });

  it("returns 404 for an unknown test", async () => {
    const { close, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: "/api/tests/12345/history" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    } finally {
      await close();
    }
  });

  it("returns 400 for a bad id or bad query parameters", async () => {
    const { close, app } = await setup();
    try {
      const urls = [
        "/api/tests/abc/history",
        "/api/tests/0/history",
        "/api/tests/1/history?status=weird",
        "/api/tests/1/history?since=yesterday",
        "/api/tests/1/history?limit=201",
        "/api/tests/1/history?offset=-1",
      ];
      for (const url of urls) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });
});
