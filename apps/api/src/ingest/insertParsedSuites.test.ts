import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { seedRepo, seedRun } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { insertParsedSuites, summarizeSuites } from "./insertParsedSuites.js";
import type { ParsedSuite } from "./junitParser.js";

const SUITES: ParsedSuite[] = [
  {
    suiteName: "A",
    testCases: [
      { classname: "pkg.Foo", name: "retry me", status: "failed", failureMessage: "boom" },
      { classname: "pkg.Foo", name: "retry me", status: "passed", durationSeconds: 0.5 },
      { classname: "pkg.Foo", name: "other", status: "skipped" },
    ],
  },
  { suiteName: "B", testCases: [{ classname: "pkg.Bar", name: "errs", status: "error" }] },
];

describe("summarizeSuites", () => {
  it("counts suites, tests and each status", () => {
    expect(summarizeSuites(SUITES)).toEqual({ suites: 2, tests: 4, passed: 1, failed: 1, error: 1, skipped: 1 });
  });

  it("returns zeros for no suites", () => {
    expect(summarizeSuites([])).toEqual({ suites: 0, tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 });
  });
});

describe("insertParsedSuites", () => {
  it("inserts suites, dedupes test_cases, and numbers repeated names with occurrence_index", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const run = await seedRun(db, repo.id, { headSha: "abc" });

      await insertParsedSuites(db, { runId: run.id, repoId: repo.id, headSha: "abc", suites: SUITES });
      // A second upload on the same repo reuses test_cases rather than duplicating them.
      await insertParsedSuites(db, { runId: run.id, repoId: repo.id, headSha: "abc", suites: SUITES });

      const { rows: cases } = await db.execute(sql`select count(*)::int as n from test_cases`);
      expect(cases[0]).toMatchObject({ n: 3 });
      const { rows: suiteRows } = await db.execute(sql`select count(*)::int as n from test_suites`);
      expect(suiteRows[0]).toMatchObject({ n: 4 });

      const { rows: retries } = await db.execute(sql`
        select tr.status, tr.occurrence_index from test_results tr
        join test_cases tc on tc.id = tr.test_case_id
        where tc.name = 'retry me' order by tr.id limit 2`);
      expect(retries).toEqual([
        { status: "failed", occurrence_index: 0 },
        { status: "passed", occurrence_index: 1 },
      ]);
      const { rows: heads } = await db.execute(sql`select distinct head_sha from test_results`);
      expect(heads).toEqual([{ head_sha: "abc" }]);
    } finally {
      await close();
    }
  });

  it("stamps suites and results with createdAt when given, and with now otherwise", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const run = await seedRun(db, repo.id, { headSha: "abc" });
      const when = new Date("2026-01-15T10:30:00.000Z");

      await insertParsedSuites(db, { runId: run.id, repoId: repo.id, headSha: "abc", suites: SUITES, createdAt: when });
      const { rows: stamped } = await db.execute(sql`
        select (select count(*)::int from test_results where created_at = ${when.toISOString()}::timestamptz) as results,
               (select count(*)::int from test_suites where created_at = ${when.toISOString()}::timestamptz) as suites`);
      expect(stamped[0]).toEqual({ results: 4, suites: 2 });

      await insertParsedSuites(db, { runId: run.id, repoId: repo.id, headSha: "abc", suites: SUITES });
      const { rows: recent } = await db.execute(
        sql`select count(*)::int as n from test_results where created_at > now() - interval '1 minute'`,
      );
      expect(recent[0]).toEqual({ n: 4 });
    } finally {
      await close();
    }
  });
});
