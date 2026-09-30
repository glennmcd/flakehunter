import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { seedRepo, seedRun } from "../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../test/testDb.js";
import { ApiError } from "../api/errors.js";
import { ingestReport } from "./ingestReport.js";

const SHA = "a".repeat(40);

const XML = `
<testsuites>
  <testsuite name="S1" tests="3">
    <testcase classname="pkg.Foo" name="passes" time="0.1" />
    <testcase classname="pkg.Foo" name="fails"><failure message="boom">stack</failure></testcase>
    <testcase classname="pkg.Foo" name="skips"><skipped /></testcase>
  </testsuite>
</testsuites>`;

const base = {
  githubRunId: 500,
  attempt: 1,
  headSha: SHA,
  headBranch: "main",
  workflowName: "CI",
  reportKey: "default",
  xml: XML,
};

async function count(db: TestDb, table: string) {
  const { rows } = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return (rows[0] as { n: number }).n;
}

async function expectApiError(promise: Promise<unknown>, code: ApiError["code"]) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

describe("ingestReport", () => {
  it("creates the run, suites and results and returns counts", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const result = await ingestReport(db, { repoId: repo.id, ...base });

      expect(result.duplicate).toBe(false);
      expect(result.run).toMatchObject({ githubRunId: 500, attempt: 1, headSha: SHA });
      expect(result.counts).toEqual({ suites: 1, tests: 3, passed: 1, failed: 1, error: 0, skipped: 1 });
      expect(await count(db, "workflow_runs")).toBe(1);
      expect(await count(db, "test_results")).toBe(3);
      expect(await count(db, "reports")).toBe(1);
    } finally {
      await close();
    }
  });

  it("treats a repeat of the same run and report key as a no-op returning the original counts", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const first = await ingestReport(db, { repoId: repo.id, ...base });
      const other = `<testsuite name="x"><testcase classname="c" name="n"/></testsuite>`;
      const second = await ingestReport(db, { repoId: repo.id, ...base, xml: other });

      expect(second.duplicate).toBe(true);
      expect(second.run.id).toBe(first.run.id);
      expect(second.counts).toEqual(first.counts);
      expect(await count(db, "test_results")).toBe(3);
      expect(await count(db, "reports")).toBe(1);
    } finally {
      await close();
    }
  });

  it("treats a different attempt as a new run", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await ingestReport(db, { repoId: repo.id, ...base });
      const second = await ingestReport(db, { repoId: repo.id, ...base, attempt: 2 });

      expect(second.duplicate).toBe(false);
      expect(await count(db, "workflow_runs")).toBe(2);
      expect(await count(db, "test_results")).toBe(6);
    } finally {
      await close();
    }
  });

  it("ingests several report keys for one run", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await ingestReport(db, { repoId: repo.id, ...base, reportKey: "unit" });
      const second = await ingestReport(db, { repoId: repo.id, ...base, reportKey: "integration" });
      const again = await ingestReport(db, { repoId: repo.id, ...base, reportKey: "unit" });

      expect(second.duplicate).toBe(false);
      expect(again.duplicate).toBe(true);
      expect(await count(db, "workflow_runs")).toBe(1);
      expect(await count(db, "reports")).toBe(2);
      expect(await count(db, "test_results")).toBe(6);
    } finally {
      await close();
    }
  });

  it("reuses a run row created earlier (e.g. by the webhook) without overwriting it", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const run = await seedRun(db, repo.id, { githubRunId: 500, headSha: SHA, headBranch: "release" });
      const result = await ingestReport(db, { repoId: repo.id, ...base, headBranch: "main", workflowName: "Upload" });

      expect(result.run.id).toBe(run.id);
      const { rows } = await db.execute(sql`select workflow_name, head_branch from workflow_runs`);
      expect(rows).toEqual([{ workflow_name: "CI", head_branch: "release" }]);
    } finally {
      await close();
    }
  });

  it("rejects a sha that disagrees with the existing run and writes nothing", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      await seedRun(db, repo.id, { githubRunId: 500, headSha: SHA });
      await expectApiError(ingestReport(db, { repoId: repo.id, ...base, headSha: "b".repeat(40) }), "validation_error");
      expect(await count(db, "reports")).toBe(0);
      expect(await count(db, "test_results")).toBe(0);
    } finally {
      await close();
    }
  });

  it("rejects non-JUnit or empty bodies with invalid_report and leaves no run behind", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      for (const xml of ["", "not xml at all", "<html><body>hi</body></html>", "<testsuites></testsuites>"]) {
        await expectApiError(ingestReport(db, { repoId: repo.id, ...base, xml }), "invalid_report");
      }
      expect(await count(db, "workflow_runs")).toBe(0);
      expect(await count(db, "reports")).toBe(0);
    } finally {
      await close();
    }
  });

  it("rolls back the run and report if inserting results fails midway", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      // The XML parser passes a NUL character through, but Postgres text columns reject it, so the
      // second test case fails after the first has already been inserted.
      const poisoned =
        '<testsuite name="S"><testcase classname="c" name="ok"/>' +
        '<testcase classname="c" name="bad"><failure message="x\u0000y"/></testcase></testsuite>';
      await expect(ingestReport(db, { repoId: repo.id, ...base, xml: poisoned })).rejects.toThrow();
      expect(await count(db, "workflow_runs")).toBe(0);
      expect(await count(db, "reports")).toBe(0);
      expect(await count(db, "test_results")).toBe(0);
    } finally {
      await close();
    }
  });
});
