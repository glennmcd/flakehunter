import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { buildApiApp } from "../../../test/apiApp.js";
import { daysAgo, seedRepo, seedResult, sha } from "../../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../../test/testDb.js";
import { API_VERSIONS, type ApiVersion, apiPrefix } from "../../api/version.js";
import flakyTestsRoute from "./flakyTests.js";

async function seedFlaky(db: TestDb, repoId: number, name: string, extraPassingShas: number, createdAt = daysAgo(1)) {
  await seedResult(db, repoId, { name, status: "passed", headSha: sha(1), createdAt });
  await seedResult(db, repoId, { name, status: "failed", headSha: sha(1), createdAt });
  for (let n = 0; n < extraPassingShas; n++) {
    await seedResult(db, repoId, { name, status: "passed", headSha: sha(n + 2), createdAt });
  }
}

async function setup(apiVersion: ApiVersion) {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const app = await buildApiApp(db, [flakyTestsRoute], apiVersion);
  return { db, close, repo, app };
}

describe.each([...API_VERSIONS])("GET /tests/flaky (v%d)", (apiVersion) => {
  const api = apiPrefix(apiVersion);

  it("returns ranked flaky tests in the paginated envelope", async () => {
    const { db, close, repo, app } = await setup(apiVersion);
    try {
      await seedFlaky(db, repo.id, "rare", 7); // 1 of 8
      await seedFlaky(db, repo.id, "common", 4); // 1 of 5

      const res = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=${repo.id}` });

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
    const { db, close, repo, app } = await setup(apiVersion);
    try {
      await seedFlaky(db, repo.id, "t", 4);
      const byId = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=${repo.id}` });
      const byName = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=acme/widgets` });

      expect(byName.statusCode).toBe(200);
      expect(byName.json()).toEqual(byId.json());
      expect(byName.json().data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("defaults to a 30 day window and a minRuns of 5", async () => {
    const { db, close, repo, app } = await setup(apiVersion);
    try {
      await seedFlaky(db, repo.id, "recent", 4);
      await seedFlaky(db, repo.id, "too old", 4, daysAgo(45));
      await seedFlaky(db, repo.id, "too few runs", 2);

      const res = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=${repo.id}` });
      expect(res.json().data.map((d: { name: string }) => d.name)).toEqual(["recent"]);
    } finally {
      await close();
    }
  });

  it("honours since, minRuns, limit and offset", async () => {
    const { db, close, repo, app } = await setup(apiVersion);
    try {
      await seedFlaky(db, repo.id, "old", 1, daysAgo(45));
      await seedFlaky(db, repo.id, "a", 1);
      await seedFlaky(db, repo.id, "b", 1);

      const since = daysAgo(60).toISOString();
      const wide = await app.inject({
        method: "GET",
        url: `${api}/tests/flaky?repo=${repo.id}&minRuns=2&since=${encodeURIComponent(since)}`,
      });
      expect(wide.json().page.total).toBe(3);

      const paged = await app.inject({
        method: "GET",
        url: `${api}/tests/flaky?repo=${repo.id}&minRuns=2&limit=1&offset=1`,
      });
      expect(paged.json().page).toEqual({ limit: 1, offset: 1, total: 2 });
      expect(paged.json().data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("returns 404 for an unknown repo", async () => {
    const { close, app } = await setup(apiVersion);
    try {
      for (const repo of ["999", "nobody/nothing"]) {
        const res = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=${repo}` });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe("not_found");
      }
    } finally {
      await close();
    }
  });

  it("returns 400 for a missing repo or invalid parameters", async () => {
    const { close, app } = await setup(apiVersion);
    try {
      const urls = [
        `${api}/tests/flaky`,
        `${api}/tests/flaky?repo=not a repo`,
        `${api}/tests/flaky?repo=1&since=yesterday`,
        `${api}/tests/flaky?repo=1&limit=201`,
        `${api}/tests/flaky?repo=1&limit=0`,
        `${api}/tests/flaky?repo=1&offset=-1`,
        `${api}/tests/flaky?repo=1&minRuns=0`,
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
    const { close, repo, app } = await setup(apiVersion);
    try {
      const res = await app.inject({ method: "GET", url: `${api}/tests/flaky?repo=${repo.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown>()).toEqual({ data: [], page: { limit: 50, offset: 0, total: 0 } });
    } finally {
      await close();
    }
  });
});

describe("GET /tests/flaky repo paths", () => {
  it("v2 resolves a nested path and a host-qualified path", async () => {
    const { db, close, app } = await setup(2);
    try {
      const nested = await seedRepo(db, { externalRepoId: 2, owner: "group/sub", name: "project" });
      await seedFlaky(db, nested.id, "t", 4);

      for (const repo of ["group/sub/project", "github:group/sub/project"]) {
        const res = await app.inject({ method: "GET", url: `/api/v2/tests/flaky?repo=${repo}` });
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toHaveLength(1);
      }
      const qualified = await app.inject({ method: "GET", url: "/api/v2/tests/flaky?repo=github:acme/widgets" });
      expect(qualified.statusCode).toBe(200);
      expect(qualified.json().data).toEqual([]);
    } finally {
      await close();
    }
  });

  it("v2 rejects an unknown host prefix and a path without an owner", async () => {
    const { close, app } = await setup(2);
    try {
      for (const repo of ["gitlab:acme/widgets", "nohost:acme/widgets", "widgets", "github:widgets", ":acme/widgets"]) {
        const res = await app.inject({ method: "GET", url: `/api/v2/tests/flaky?repo=${repo}` });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });

  it("v2 refuses a bare path that matches repositories on two hosts, naming both, and accepts it qualified", async () => {
    const { db, close, repo, app } = await setup(2);
    try {
      // Only `github` passes the host check today, so lift it to stand in for a second host.
      await db.execute(sql`alter table repos drop constraint repos_host_check`);
      await db.execute(
        sql`insert into repos (host, external_repo_id, owner, name, full_name) values ('gitlab', 2, 'acme', 'widgets', 'acme/widgets')`,
      );
      await seedFlaky(db, repo.id, "t", 4);

      const bare = await app.inject({ method: "GET", url: "/api/v2/tests/flaky?repo=acme/widgets" });
      expect(bare.statusCode).toBe(400);
      expect(bare.json().error.message).toContain("github, gitlab");

      const qualified = await app.inject({ method: "GET", url: "/api/v2/tests/flaky?repo=github:acme/widgets" });
      expect(qualified.statusCode).toBe(200);
      expect(qualified.json().data).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
