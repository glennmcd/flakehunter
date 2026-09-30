import { describe, expect, it } from "bun:test";
import { createTestDb } from "../../test/testDb.js";
import { repos, testCases, testResults, testSuites, workflowRuns } from "../db/schema.js";
import { getFlakyTests, getFlakyTestsSummary } from "./flakyQueries.js";

describe("flakyQueries", () => {
  it("returns flaky rows from the view and an aggregated summary", async () => {
    const { db, close } = await createTestDb();
    try {
      const [repo] = await db
        .insert(repos)
        .values({ githubRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
        .returning({ id: repos.id });
      if (!repo) throw new Error("failed to seed repo");

      const [run] = await db
        .insert(workflowRuns)
        .values({
          repoId: repo.id,
          githubRunId: 1,
          workflowName: "CI",
          headSha: "sha1",
          status: "completed",
        })
        .returning({ id: workflowRuns.id });
      if (!run) throw new Error("failed to seed run");

      const [suite] = await db
        .insert(testSuites)
        .values({ runId: run.id, suiteName: "Suite1" })
        .returning({ id: testSuites.id });
      if (!suite) throw new Error("failed to seed suite");

      const [testCase] = await db
        .insert(testCases)
        .values({ repoId: repo.id, classname: "pkg.Foo", name: "flaky test" })
        .returning({ id: testCases.id });
      if (!testCase) throw new Error("failed to seed test case");

      await db.insert(testResults).values([
        {
          testCaseId: testCase.id,
          suiteId: suite.id,
          runId: run.id,
          repoId: repo.id,
          headSha: "sha1",
          status: "passed",
        },
        {
          testCaseId: testCase.id,
          suiteId: suite.id,
          runId: run.id,
          repoId: repo.id,
          headSha: "sha1",
          status: "failed",
        },
      ]);

      const flaky = await getFlakyTests(db, repo.id);
      expect(flaky).toHaveLength(1);
      expect(flaky[0]).toMatchObject({ classname: "pkg.Foo", name: "flaky test", passCount: 1, failCount: 1 });

      const summary = await getFlakyTestsSummary(db, repo.id);
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ classname: "pkg.Foo", name: "flaky test", flakyShaCount: 1 });
    } finally {
      await close();
    }
  });
});
