import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { daysAgo, seedRepo, seedResult, seedRun, sha } from "../../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../../test/testDb.js";
import repoSummaryRoute from "./repoSummary.js";

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const app = await buildApiApp(db, [repoSummaryRoute]);
  return { db, close, repo, app };
}

/** Two runs inside the default window, one 40 days old. Returns their ids and timestamps. */
async function seedFixture(db: TestDb, repoId: number) {
  const r1At = daysAgo(2);
  const r2At = daysAgo(1);
  const oldAt = daysAgo(40);
  const r1 = await seedRun(db, repoId, { githubRunId: 1, headSha: sha(1), createdAt: r1At });
  const r2 = await seedRun(db, repoId, { githubRunId: 2, headSha: sha(2), createdAt: r2At });
  const old = await seedRun(db, repoId, { githubRunId: 3, headSha: sha(9), createdAt: oldAt });

  // A is flaky on sha(1) (pass + fail); B passes; C errors; D is skipped.
  await seedResult(db, repoId, { name: "A", status: "passed", headSha: sha(1), runId: r1.id, createdAt: r1At });
  await seedResult(db, repoId, { name: "A", status: "failed", headSha: sha(1), runId: r1.id, createdAt: r1At });
  await seedResult(db, repoId, { name: "B", status: "passed", headSha: sha(2), runId: r2.id, createdAt: r2At });
  await seedResult(db, repoId, { name: "C", status: "error", headSha: sha(2), runId: r2.id, createdAt: r2At });
  await seedResult(db, repoId, { name: "D", status: "skipped", headSha: sha(2), runId: r2.id, createdAt: r2At });
  // Outside the window: a failure of a test that is otherwise unseen.
  await seedResult(db, repoId, { name: "E", status: "failed", headSha: sha(9), runId: old.id, createdAt: oldAt });
  return { r2At, oldAt };
}

describe("GET /api/repos/:id/summary", () => {
  it("returns windowed totals for a repo", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const { r2At } = await seedFixture(db, repo.id);

      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.repo).toEqual({ id: repo.id, fullName: "acme/widgets" });
      expect(body.totals).toEqual({
        runs: 2,
        tests: 4,
        results: 5,
        passRate: 0.5, // 2 passed of (2 passed + 1 failed + 1 error); skipped excluded
        flakyTests: 1,
        flakyShas: 1,
      });
      expect(body.lastRunAt).toBe(r2At.toISOString());
    } finally {
      await close();
    }
  });

  it("widens the totals when since reaches further back", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedFixture(db, repo.id);
      const sinceDate = daysAgo(50);
      const since = encodeURIComponent(sinceDate.toISOString());

      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary?since=${since}` });

      expect(res.json().totals).toMatchObject({ runs: 3, tests: 5, results: 6, flakyTests: 1, flakyShas: 1 });
      expect(res.json().window.since).toBe(sinceDate.toISOString());
    } finally {
      await close();
    }
  });

  it("echoes the window start, defaulting to 30 days ago", async () => {
    const { close, repo, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      const since = new Date(res.json().window.since).getTime();
      expect(Math.abs(since - daysAgo(30).getTime())).toBeLessThan(60_000);
    } finally {
      await close();
    }
  });

  it("returns zeros, a null passRate and a null lastRunAt for an empty repo", async () => {
    const { close, repo, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      expect(res.statusCode).toBe(200);
      expect(res.json().totals).toEqual({ runs: 0, tests: 0, results: 0, passRate: null, flakyTests: 0, flakyShas: 0 });
      expect(res.json().lastRunAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("has a null passRate when every result is skipped", async () => {
    const { db, close, repo, app } = await setup();
    try {
      await seedResult(db, repo.id, { status: "skipped", headSha: sha(1) });
      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      expect(res.json().totals).toMatchObject({ results: 1, tests: 1, passRate: null });
    } finally {
      await close();
    }
  });

  it("reports lastRunAt for the most recent run even when it is outside the window", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const at = daysAgo(40);
      await seedRun(db, repo.id, { githubRunId: 1, createdAt: at });
      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      expect(res.json().totals.runs).toBe(0);
      expect(res.json().lastRunAt).toBe(at.toISOString());
    } finally {
      await close();
    }
  });

  it("counts flaky shas per test-and-commit pair and flaky tests once each", async () => {
    const { db, close, repo, app } = await setup();
    try {
      for (const n of [1, 2]) {
        await seedResult(db, repo.id, { name: "flaky", status: "passed", headSha: sha(n) });
        await seedResult(db, repo.id, { name: "flaky", status: "failed", headSha: sha(n) });
      }
      await seedResult(db, repo.id, { name: "other", status: "passed", headSha: sha(1) });
      await seedResult(db, repo.id, { name: "other", status: "error", headSha: sha(1) });

      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      expect(res.json().totals).toMatchObject({ flakyTests: 2, flakyShas: 3 });
    } finally {
      await close();
    }
  });

  it("ignores other repos", async () => {
    const { db, close, repo, app } = await setup();
    try {
      const other = await seedRepo(db, { githubRepoId: 2, name: "other" });
      await seedFixture(db, other.id);

      const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/summary` });
      expect(res.json().totals).toEqual({ runs: 0, tests: 0, results: 0, passRate: null, flakyTests: 0, flakyShas: 0 });
    } finally {
      await close();
    }
  });

  it("returns 404 for an unknown repo", async () => {
    const { close, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos/999/summary" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    } finally {
      await close();
    }
  });

  it("returns 400 for a bad id or bad since", async () => {
    const { close, app } = await setup();
    try {
      for (const url of ["/api/repos/abc/summary", "/api/repos/0/summary", "/api/repos/1/summary?since=yesterday"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });
});
