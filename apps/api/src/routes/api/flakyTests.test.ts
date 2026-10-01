import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { daysAgo, seedRepo, seedResult, sha } from "../../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../../test/testDb.js";
import flakyTestsRoute from "./flakyTests.js";

async function seedFlaky(db: TestDb, repoId: number, name: string, extraPassingShas: number, createdAt = daysAgo(1)) {
  await seedResult(db, repoId, { name, status: "passed", headSha: sha(1), createdAt });
  await seedResult(db, repoId, { name, status: "failed", headSha: sha(1), createdAt });
  for (let n = 0; n < extraPassingShas; n++) {
    await seedResult(db, repoId, { name, status: "passed", headSha: sha(n + 2), createdAt });
  }
}

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const app = await buildApiApp(db, [flakyTestsRoute]);
  return { db, close, repo, app };
}

describe("GET /api/tests/flaky", () => {
  it("returns ranked flaky tests in the paginated envelope", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedFlaky(db, repo.id, "rare", 7); // 1 of 8
      await seedFlaky(db, repo.id, "common", 4); // 1 of 5

      const res = await app.inject({ method: "GET", url: `/api/tests/flaky?repo=${repo.id}` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toEqual({ limit: 50, offset: 0, total: 2 });
      expect(body.data.map((d: { name: string }) => d.name)).toEqual(["common", "rare"]);
      expect(body.data[0]).toEqual({
        testId: expect.any(Number),
        classname: "pkg.Foo",
        name: "common",
        shasRun: 5,
        flakyShas: 1,
        flakeRate: 0.2,
        lastFlakyAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    } finally {
      await close();
    }
  });

  it("resolves the repo by numeric id or by owner/name", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedFlaky(db, repo.id, "t", 4);
      const byId = await app.inject({ method: "GET", url: `/api/tests/flaky?repo=${repo.id}` });
      const byName = await app.inject({ method: "GET", url: "/api/tests/flaky?repo=acme/widgets" });

      expect(byName.statusCode).toBe(200);
      expect(byName.json()).toEqual(byId.json());
      expect(byName.json().data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("defaults to a 30 day window and a minRuns of 5", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedFlaky(db, repo.id, "recent", 4);
      await seedFlaky(db, repo.id, "too old", 4, daysAgo(45));
      await seedFlaky(db, repo.id, "too few runs", 2);

      const res = await app.inject({ method: "GET", url: `/api/tests/flaky?repo=${repo.id}` });
      expect(res.json().data.map((d: { name: string }) => d.name)).toEqual(["recent"]);
    } finally {
      await close();
    }
  });

  it("honours since, minRuns, limit and offset", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedFlaky(db, repo.id, "old", 1, daysAgo(45));
      await seedFlaky(db, repo.id, "a", 1);
      await seedFlaky(db, repo.id, "b", 1);

      const since = daysAgo(60).toISOString();
      const wide = await app.inject({
        method: "GET",
        url: `/api/tests/flaky?repo=${repo.id}&minRuns=2&since=${encodeURIComponent(since)}`,
      });
      expect(wide.json().page.total).toBe(3);

      const paged = await app.inject({
        method: "GET",
        url: `/api/tests/flaky?repo=${repo.id}&minRuns=2&limit=1&offset=1`,
      });
      expect(paged.json().page).toEqual({ limit: 1, offset: 1, total: 2 });
      expect(paged.json().data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("returns 404 for an unknown repo", async () => {
    const { close, app } = await setup();
    try {
      for (const repo of ["999", "nobody/nothing"]) {
        const res = await app.inject({ method: "GET", url: `/api/tests/flaky?repo=${repo}` });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe("not_found");
      }
    } finally {
      await close();
    }
  });

  it("returns 400 for a missing repo or invalid parameters", async () => {
    const { close, app } = await setup();
    try {
      const urls = [
        "/api/tests/flaky",
        "/api/tests/flaky?repo=not a repo",
        "/api/tests/flaky?repo=1&since=yesterday",
        "/api/tests/flaky?repo=1&limit=201",
        "/api/tests/flaky?repo=1&limit=0",
        "/api/tests/flaky?repo=1&offset=-1",
        "/api/tests/flaky?repo=1&minRuns=0",
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

  it("returns an empty page for a repo with no flaky tests", async () => {
    const { close, repo, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/tests/flaky?repo=${repo.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown>()).toEqual({ data: [], page: { limit: 50, offset: 0, total: 0 } });
    } finally {
      await close();
    }
  });
});
