import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { daysAgo, seedRepo, seedResult, sha } from "../../../test/fixtures.js";
import { createTestDb } from "../../../test/testDb.js";
import testFailuresRoute from "./testFailures.js";

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const app = await buildApiApp(db, [testFailuresRoute]);
  return { db, close, repo, app };
}

describe("GET /api/tests/:id/failures", () => {
  it("returns only failed and error results, newest first, with run details", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const first = await seedResult(db, repo.id, {
        status: "failed",
        headSha: sha(1),
        createdAt: daysAgo(3),
        failureMessage: "boom",
      });
      await seedResult(db, repo.id, { status: "passed", headSha: sha(2), createdAt: daysAgo(2) });
      await seedResult(db, repo.id, { status: "skipped", headSha: sha(3), createdAt: daysAgo(2) });
      await seedResult(db, repo.id, {
        status: "error",
        headSha: sha(4),
        createdAt: daysAgo(1),
        failureMessage: "crash",
        failureStack: "secret stack",
      });

      const res = await app.inject({ method: "GET", url: `/api/tests/${first.testCase.id}/failures` });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: { headSha: string }[] }>();
      expect(res.json<unknown>()).toEqual({
        test: { id: first.testCase.id, repoId: repo.id, classname: "pkg.Foo", name: "a test" },
        data: [
          {
            resultId: expect.any(Number),
            status: "error",
            headSha: sha(4),
            headBranch: "main",
            failureMessage: "crash",
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
            run: {
              id: expect.any(Number),
              githubRunId: expect.any(Number),
              attempt: 1,
              workflowName: "CI",
              htmlUrl: null,
            },
          },
          expect.objectContaining({ status: "failed", headSha: sha(1), failureMessage: "boom" }),
        ],
      });
      expect(body.data).toHaveLength(2);
      expect(res.body).not.toContain("secret stack");
      expect(res.body).not.toContain("failureStack");
    } finally {
      await close();
    }
  });

  it("returns at most the 50 most recent failures", async () => {
    const { db, close, repo, app } = await setup();
    try {
      let testId = 0;
      for (let i = 1; i <= 60; i++) {
        const seeded = await seedResult(db, repo.id, {
          status: "failed",
          headSha: sha(i),
          createdAt: daysAgo(100 - i),
          failureMessage: `fail ${i}`,
        });
        testId = seeded.testCase.id;
      }

      const res = await app.inject({ method: "GET", url: `/api/tests/${testId}/failures` });

      const data = res.json<{ data: { failureMessage: string }[] }>().data;
      expect(data).toHaveLength(50);
      expect(data[0]?.failureMessage).toBe("fail 60");
      expect(data[49]?.failureMessage).toBe("fail 11");
    } finally {
      await close();
    }
  });

  it("includes failures that have no message", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const { testCase } = await seedResult(db, repo.id, { status: "failed", headSha: sha(1) });
      const res = await app.inject({ method: "GET", url: `/api/tests/${testCase.id}/failures` });
      expect(res.json<{ data: { failureMessage: null }[] }>().data[0]?.failureMessage).toBeNull();
    } finally {
      await close();
    }
  });

  it("returns an empty list for a test that never failed", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const { testCase } = await seedResult(db, repo.id, { status: "passed", headSha: sha(1) });
      const res = await app.inject({ method: "GET", url: `/api/tests/${testCase.id}/failures` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown[] }>().data).toEqual([]);
    } finally {
      await close();
    }
  });

  it("ignores other tests' failures", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const mine = await seedResult(db, repo.id, { name: "mine", status: "failed", headSha: sha(1) });
      await seedResult(db, repo.id, { name: "other", status: "failed", headSha: sha(1) });
      const res = await app.inject({ method: "GET", url: `/api/tests/${mine.testCase.id}/failures` });
      expect(res.json<{ data: unknown[] }>().data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("returns 404 for an unknown test", async () => {
    const { close, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: "/api/tests/999/failures" });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("not_found");
    } finally {
      await close();
    }
  });

  it("returns 400 for a bad id", async () => {
    const { close, app } = await setup();
    try {
      for (const url of ["/api/tests/abc/failures", "/api/tests/0/failures"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ error: { code: string } }>().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });
});
