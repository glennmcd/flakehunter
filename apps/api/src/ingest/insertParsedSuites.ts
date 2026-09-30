import { sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { testCases, testResults, testSuites } from "../db/schema.js";
import type { ParsedSuite } from "./junitParser.js";

export interface ReportCounts {
  suites: number;
  tests: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export function summarizeSuites(suites: ParsedSuite[]): ReportCounts {
  const counts: ReportCounts = { suites: suites.length, tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const suite of suites) {
    for (const tc of suite.testCases) {
      counts.tests++;
      counts[tc.status]++;
    }
  }
  return counts;
}

export interface InsertParsedSuitesInput {
  runId: number;
  repoId: number;
  headSha: string;
  suites: ParsedSuite[];
}

/**
 * Persists parsed JUnit suites for a run: one test_suites row per suite, test_cases upserted on
 * (repo_id, classname, name), and one test_results row per case. Duplicate names within a suite
 * (retries) get an increasing occurrence_index. Callers are responsible for idempotency (see `reports`).
 */
export async function insertParsedSuites(db: AnyDb, input: InsertParsedSuitesInput): Promise<void> {
  for (const suite of input.suites) {
    const [suiteRow] = await db
      .insert(testSuites)
      .values({
        runId: input.runId,
        suiteName: suite.suiteName,
        fileName: suite.fileName,
        tests: suite.tests,
        failures: suite.failures,
        errors: suite.errors,
        skipped: suite.skipped,
        timeSeconds: suite.timeSeconds?.toString(),
      })
      .returning({ id: testSuites.id });

    if (!suiteRow) throw new Error("Failed to insert test_suites row");

    const occurrenceCounts = new Map<string, number>();

    for (const tc of suite.testCases) {
      const key = `${tc.classname}::${tc.name}`;
      const occurrenceIndex = occurrenceCounts.get(key) ?? 0;
      occurrenceCounts.set(key, occurrenceIndex + 1);

      const [testCaseRow] = await db
        .insert(testCases)
        .values({ repoId: input.repoId, classname: tc.classname, name: tc.name })
        .onConflictDoUpdate({
          target: [testCases.repoId, testCases.classname, testCases.name],
          set: { classname: sql`excluded.classname` },
        })
        .returning({ id: testCases.id });

      if (!testCaseRow) throw new Error("Failed to upsert test_cases row");

      await db.insert(testResults).values({
        testCaseId: testCaseRow.id,
        suiteId: suiteRow.id,
        runId: input.runId,
        repoId: input.repoId,
        headSha: input.headSha,
        occurrenceIndex,
        status: tc.status,
        durationSeconds: tc.durationSeconds?.toString(),
        failureMessage: tc.failureMessage,
        failureStack: tc.failureStack,
      });
    }
  }
}
