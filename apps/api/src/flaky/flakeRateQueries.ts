import type { FlakyTestItem } from "@flakehunter/shared-types";
import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { testCases, testResults } from "../db/schema.js";

export interface FlakeRankingQuery {
  repoId: number;
  since: Date;
  minRuns: number;
  limit: number;
  offset: number;
}

/**
 * Builds the two CTEs behind the ranking. Built with the query builder rather than raw SQL so the same code
 * runs on postgres-js and PGlite (db.execute returns different shapes on each).
 *
 * per_sha:  one row per (test, commit) in the window, skipped results ignored, flagged when that commit saw
 *           both a pass and a failure/error.
 * per_test: rolls per_sha up per test; keeps tests that ran on at least `minRuns` commits and were flaky on one.
 */
function flakeCtes(db: AnyDb, { repoId, since, minRuns }: Pick<FlakeRankingQuery, "repoId" | "since" | "minRuns">) {
  const perSha = db.$with("per_sha").as(
    db
      .select({
        testCaseId: testResults.testCaseId,
        headSha: testResults.headSha,
        hasPass: sql<boolean>`bool_or(${testResults.status} = 'passed')`.as("has_pass"),
        hasFail: sql<boolean>`bool_or(${testResults.status} in ('failed', 'error'))`.as("has_fail"),
        lastSeen: sql<Date>`max(${testResults.createdAt})`.as("last_seen"),
      })
      .from(testResults)
      .where(and(eq(testResults.repoId, repoId), gte(testResults.createdAt, since), ne(testResults.status, "skipped")))
      .groupBy(testResults.testCaseId, testResults.headSha),
  );

  const isFlaky = sql`(${perSha.hasPass} and ${perSha.hasFail})`;

  const perTest = db.$with("per_test").as(
    db
      .with(perSha)
      .select({
        testCaseId: perSha.testCaseId,
        shasRun: sql<number>`count(*)`.mapWith(Number).as("shas_run"),
        flakyShas: sql<number>`count(*) filter (where ${isFlaky})`.mapWith(Number).as("flaky_shas"),
        lastFlakyAt: sql<Date>`max(${perSha.lastSeen}) filter (where ${isFlaky})`.as("last_flaky_at"),
      })
      .from(perSha)
      .groupBy(perSha.testCaseId)
      .having(sql`count(*) >= ${minRuns} and count(*) filter (where ${isFlaky}) >= 1`),
  );

  return { perSha, perTest };
}

export async function getFlakeRanking(
  db: AnyDb,
  query: FlakeRankingQuery,
): Promise<{ data: FlakyTestItem[]; total: number }> {
  const { perSha, perTest } = flakeCtes(db, query);
  const flakeRate = sql<number>`${perTest.flakyShas}::float8 / ${perTest.shasRun}`;

  const rows = await db
    .with(perSha, perTest)
    .select({
      testId: perTest.testCaseId,
      classname: testCases.classname,
      name: testCases.name,
      shasRun: perTest.shasRun,
      flakyShas: perTest.flakyShas,
      flakeRate: flakeRate.mapWith(Number),
      lastFlakyAt: sql<string>`to_char(${perTest.lastFlakyAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(perTest)
    .innerJoin(testCases, eq(testCases.id, perTest.testCaseId))
    .orderBy(desc(flakeRate), desc(perTest.flakyShas), asc(perTest.testCaseId))
    .limit(query.limit)
    .offset(query.offset);

  const [totalRow] = await db
    .with(perSha, perTest)
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(perTest);

  return { data: rows, total: totalRow?.total ?? 0 };
}
