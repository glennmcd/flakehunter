import type { RepoSummaryResponse } from "@flakehunter/shared-types";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { testResults, workflowRuns } from "../db/schema.js";
import { perShaCte } from "../flaky/flakeRateQueries.js";

export interface RepoSummaryQuery {
  repoId: number;
  since: Date;
}

type Totals = RepoSummaryResponse["totals"];

/**
 * Dashboard totals for one repo. runs, tests, results and the flaky counts are limited to the window;
 * lastRunAt is the most recent run overall (so a quiet repo still shows when it last ran).
 * results counts every status; passRate = passed / (passed + failed + error), null if that is zero.
 */
export async function getRepoSummary(
  db: AnyDb,
  { repoId, since }: RepoSummaryQuery,
): Promise<{ totals: Totals; lastRunAt: string | null }> {
  const [runAgg] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${gte(workflowRuns.createdAt, since)})`.mapWith(Number),
      lastRunAt: sql<
        string | null
      >`to_char(max(${workflowRuns.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.repoId, repoId));

  const [resultAgg] = await db
    .select({
      results: sql<number>`count(*)`.mapWith(Number),
      tests: sql<number>`count(distinct ${testResults.testCaseId})`.mapWith(Number),
      passed: sql<number>`count(*) filter (where ${testResults.status} = 'passed')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${testResults.status} in ('failed', 'error'))`.mapWith(Number),
    })
    .from(testResults)
    .where(and(eq(testResults.repoId, repoId), gte(testResults.createdAt, since)));

  const { perSha, isFlaky } = perShaCte(db, { repoId, since });
  const [flakyAgg] = await db
    .with(perSha)
    .select({
      flakyTests: sql<number>`count(distinct ${perSha.testCaseId}) filter (where ${isFlaky})`.mapWith(Number),
      flakyShas: sql<number>`count(*) filter (where ${isFlaky})`.mapWith(Number),
    })
    .from(perSha);

  const passed = resultAgg?.passed ?? 0;
  const failed = resultAgg?.failed ?? 0;

  return {
    totals: {
      runs: runAgg?.runs ?? 0,
      tests: resultAgg?.tests ?? 0,
      results: resultAgg?.results ?? 0,
      passRate: passed + failed === 0 ? null : passed / (passed + failed),
      flakyTests: flakyAgg?.flakyTests ?? 0,
      flakyShas: flakyAgg?.flakyShas ?? 0,
    },
    lastRunAt: runAgg?.lastRunAt ?? null,
  };
}
