import type { TestHistoryResponse } from "@flakehunter/shared-types";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { testCases, testResults, workflowRuns } from "../db/schema.js";

export interface TestHistoryQuery {
  testId: number;
  since?: Date;
  status?: "passed" | "failed" | "error" | "skipped";
  limit: number;
  offset: number;
}

/** Newest-first result history for one test, or null if the test does not exist. failureStack is never selected. */
export async function getTestHistory(db: AnyDb, query: TestHistoryQuery): Promise<TestHistoryResponse | null> {
  const [test] = await db
    .select({ id: testCases.id, repoId: testCases.repoId, classname: testCases.classname, name: testCases.name })
    .from(testCases)
    .where(eq(testCases.id, query.testId));
  if (!test) return null;

  const where = and(
    eq(testResults.testCaseId, query.testId),
    query.since ? gte(testResults.createdAt, query.since) : undefined,
    query.status ? eq(testResults.status, query.status) : undefined,
  );

  const rows = await db
    .select({
      resultId: testResults.id,
      status: testResults.status,
      headSha: testResults.headSha,
      headBranch: workflowRuns.headBranch,
      occurrenceIndex: testResults.occurrenceIndex,
      durationSeconds: testResults.durationSeconds,
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
    .where(where)
    .orderBy(desc(testResults.createdAt), desc(testResults.id))
    .limit(query.limit)
    .offset(query.offset);

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(testResults)
    .where(where);

  return {
    test,
    data: rows.map((row) => ({
      resultId: row.resultId,
      status: row.status as TestHistoryResponse["data"][number]["status"],
      headSha: row.headSha,
      headBranch: row.headBranch,
      occurrenceIndex: row.occurrenceIndex,
      durationSeconds: row.durationSeconds === null ? null : Number(row.durationSeconds),
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
    page: { limit: query.limit, offset: query.offset, total: totalRow?.total ?? 0 },
  };
}
