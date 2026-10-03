import type { TestFailuresResponse } from "@flakehunter/shared-types";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { testCases, testResults, workflowRuns } from "../db/schema.js";

export const FAILURE_LIMIT = 50;

/** Newest-first failed/error results for one test (at most FAILURE_LIMIT), or null if the test does not exist. */
export async function getTestFailures(db: AnyDb, testId: number): Promise<TestFailuresResponse | null> {
  const [test] = await db
    .select({ id: testCases.id, repoId: testCases.repoId, classname: testCases.classname, name: testCases.name })
    .from(testCases)
    .where(eq(testCases.id, testId));
  if (!test) return null;

  const rows = await db
    .select({
      resultId: testResults.id,
      status: testResults.status,
      headSha: testResults.headSha,
      headBranch: workflowRuns.headBranch,
      failureMessage: testResults.failureMessage,
      createdAt: testResults.createdAt,
      runId: workflowRuns.id,
      githubRunId: workflowRuns.githubRunId,
      attempt: workflowRuns.githubRunAttempt,
      workflowName: workflowRuns.workflowName,
      htmlUrl: workflowRuns.htmlUrl,
    })
    .from(testResults)
    .innerJoin(workflowRuns, eq(workflowRuns.id, testResults.runId))
    .where(and(eq(testResults.testCaseId, testId), inArray(testResults.status, ["failed", "error"])))
    .orderBy(desc(testResults.createdAt), desc(testResults.id))
    .limit(FAILURE_LIMIT);

  return {
    test,
    data: rows.map((row) => ({
      resultId: row.resultId,
      status: row.status as "failed" | "error",
      headSha: row.headSha,
      headBranch: row.headBranch,
      failureMessage: row.failureMessage,
      createdAt: new Date(row.createdAt).toISOString(),
      run: {
        id: row.runId,
        githubRunId: row.githubRunId,
        attempt: row.attempt,
        workflowName: row.workflowName,
        htmlUrl: row.htmlUrl,
      },
    })),
  };
}
