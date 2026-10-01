import { describe, expect, it } from "bun:test";
import { daysAgo, seedRepo, seedResult, sha } from "../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../test/testDb.js";
import { getFlakeRanking } from "./flakeRateQueries.js";

type Status = "passed" | "failed" | "error" | "skipped";

/** One result per sha for `name`: statuses[i] is the only result on sha(i + 1). */
async function seedOnePerSha(db: TestDb, repoId: number, name: string, statuses: Status[], createdAt = daysAgo(1)) {
  for (const [i, status] of statuses.entries()) {
    await seedResult(db, repoId, { name, status, headSha: sha(i + 1), createdAt });
  }
}

/** A flaky sha: a pass and a fail on the same commit. */
async function seedFlakySha(db: TestDb, repoId: number, name: string, headSha: string, createdAt = daysAgo(1)) {
  await seedResult(db, repoId, { name, status: "passed", headSha, createdAt });
  await seedResult(db, repoId, { name, status: "failed", headSha, createdAt });
}

const query = { since: daysAgo(30), minRuns: 1, limit: 50, offset: 0 };

describe("getFlakeRanking", () => {
  it("computes flakeRate as flaky shas divided by shas run", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedFlakySha(db, repo.id, "flaky", sha(1));
      for (const n of [2, 3, 4, 5]) await seedResult(db, repo.id, { name: "flaky", status: "passed", headSha: sha(n) });

      const { data, total } = await getFlakeRanking(db, { repoId: repo.id, ...query });

      expect(total).toBe(1);
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ name: "flaky", classname: "pkg.Foo", shasRun: 5, flakyShas: 1, flakeRate: 0.2 });
    } finally {
      await close();
    }
  });

  it("excludes tests that only ever pass or only ever fail", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedOnePerSha(db, repo.id, "always passes", ["passed", "passed", "passed"]);
      await seedOnePerSha(db, repo.id, "always fails", ["failed", "failed", "error"]);
      // Fails on one commit, passes on another: a regression fix, not a flake.
      await seedOnePerSha(db, repo.id, "fixed later", ["failed", "passed"]);

      const { data, total } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data).toEqual([]);
      expect(total).toBe(0);
    } finally {
      await close();
    }
  });

  it("counts an error as a failure", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedResult(db, repo.id, { name: "t", status: "passed", headSha: sha(1) });
      await seedResult(db, repo.id, { name: "t", status: "error", headSha: sha(1) });

      const { data } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data[0]).toMatchObject({ shasRun: 1, flakyShas: 1, flakeRate: 1 });
    } finally {
      await close();
    }
  });

  it("ignores skipped results entirely", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedFlakySha(db, repo.id, "t", sha(1));
      // A sha where the test was only skipped does not count as a run, and skip + pass is not flaky.
      await seedResult(db, repo.id, { name: "t", status: "skipped", headSha: sha(2) });
      await seedResult(db, repo.id, { name: "t", status: "passed", headSha: sha(3) });
      await seedResult(db, repo.id, { name: "t", status: "skipped", headSha: sha(3) });

      const { data } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data[0]).toMatchObject({ shasRun: 2, flakyShas: 1, flakeRate: 0.5 });
    } finally {
      await close();
    }
  });

  it("only considers results inside the since window", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedFlakySha(db, repo.id, "old flake", sha(1), daysAgo(60));
      await seedFlakySha(db, repo.id, "recent flake", sha(2), daysAgo(2));
      // Old passing history must not dilute the rate of a recent flake.
      await seedResult(db, repo.id, {
        name: "recent flake",
        status: "passed",
        headSha: sha(3),
        createdAt: daysAgo(90),
      });

      const { data } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data.map((d) => d.name)).toEqual(["recent flake"]);
      expect(data[0]).toMatchObject({ shasRun: 1, flakyShas: 1 });
    } finally {
      await close();
    }
  });

  it("applies the minRuns cutoff to shas run", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedFlakySha(db, repo.id, "t", sha(1));
      await seedResult(db, repo.id, { name: "t", status: "passed", headSha: sha(2) });
      await seedResult(db, repo.id, { name: "t", status: "passed", headSha: sha(3) });

      const strict = await getFlakeRanking(db, { repoId: repo.id, ...query, minRuns: 4 });
      expect(strict.data).toEqual([]);
      expect(strict.total).toBe(0);

      const exact = await getFlakeRanking(db, { repoId: repo.id, ...query, minRuns: 3 });
      expect(exact.data).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("ranks by flakeRate, then flakyShas, then test id", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      // "half": 1 of 2 (0.5). "quarter a/b": 1 of 4 (0.25), ties broken by id. "two of eight": 2 of 8 (0.25) ranks above.
      await seedFlakySha(db, repo.id, "quarter a", sha(1));
      for (const n of [2, 3, 4])
        await seedResult(db, repo.id, { name: "quarter a", status: "passed", headSha: sha(n) });
      await seedFlakySha(db, repo.id, "half", sha(1));
      await seedResult(db, repo.id, { name: "half", status: "passed", headSha: sha(2) });
      await seedFlakySha(db, repo.id, "quarter b", sha(1));
      for (const n of [2, 3, 4])
        await seedResult(db, repo.id, { name: "quarter b", status: "passed", headSha: sha(n) });
      await seedFlakySha(db, repo.id, "two of eight", sha(1));
      await seedFlakySha(db, repo.id, "two of eight", sha(2));
      for (const n of [3, 4, 5, 6, 7, 8])
        await seedResult(db, repo.id, { name: "two of eight", status: "passed", headSha: sha(n) });

      const { data } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data.map((d) => d.name)).toEqual(["half", "two of eight", "quarter a", "quarter b"]);
    } finally {
      await close();
    }
  });

  it("paginates and reports the total across pages", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      for (const name of ["a", "b", "c"]) await seedFlakySha(db, repo.id, name, sha(1));

      const page1 = await getFlakeRanking(db, { repoId: repo.id, ...query, limit: 2, offset: 0 });
      const page2 = await getFlakeRanking(db, { repoId: repo.id, ...query, limit: 2, offset: 2 });
      const beyond = await getFlakeRanking(db, { repoId: repo.id, ...query, limit: 2, offset: 10 });

      expect(page1.data.map((d) => d.name)).toEqual(["a", "b"]);
      expect(page2.data.map((d) => d.name)).toEqual(["c"]);
      expect([page1.total, page2.total, beyond.total]).toEqual([3, 3, 3]);
      expect(beyond.data).toEqual([]);
    } finally {
      await close();
    }
  });

  it("is scoped to the requested repo", async () => {
    const { db, close } = await createTestDb();
    try {
      const a = await seedRepo(db, { githubRepoId: 1, name: "a" });
      const b = await seedRepo(db, { githubRepoId: 2, name: "b" });
      await seedFlakySha(db, a.id, "only in a", sha(1));

      expect((await getFlakeRanking(db, { repoId: a.id, ...query })).total).toBe(1);
      expect((await getFlakeRanking(db, { repoId: b.id, ...query })).total).toBe(0);
    } finally {
      await close();
    }
  });

  it("reports lastFlakyAt as the latest time a flaky sha was seen, as an ISO string", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const older = daysAgo(5);
      const newer = daysAgo(2);
      await seedFlakySha(db, repo.id, "t", sha(1), older);
      await seedFlakySha(db, repo.id, "t", sha(2), newer);
      // Non-flaky activity after the last flake must not move lastFlakyAt.
      await seedResult(db, repo.id, { name: "t", status: "passed", headSha: sha(3), createdAt: daysAgo(1) });

      const { data } = await getFlakeRanking(db, { repoId: repo.id, ...query });
      expect(data[0]?.lastFlakyAt).toBe(newer.toISOString());
    } finally {
      await close();
    }
  });
});
