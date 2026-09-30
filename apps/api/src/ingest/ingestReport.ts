import { and, eq } from "drizzle-orm";
import { ApiError } from "../api/errors.js";
import type { AnyDb } from "../db/client.js";
import { reports, workflowRuns } from "../db/schema.js";
import { insertParsedSuites, type ReportCounts, summarizeSuites } from "./insertParsedSuites.js";
import { type ParsedSuite, parseJunitXml } from "./junitParser.js";

export interface IngestReportInput {
  repoId: number;
  githubRunId: number;
  attempt: number;
  headSha: string;
  headBranch?: string;
  workflowName: string;
  reportKey: string;
  xml: string;
}

export interface IngestReportResult {
  run: { id: number; githubRunId: number; attempt: number; headSha: string };
  duplicate: boolean;
  counts: ReportCounts;
}

function parseReport(xml: string): ParsedSuite[] {
  let suites: ParsedSuite[];
  try {
    suites = parseJunitXml(xml);
  } catch {
    throw new ApiError("invalid_report", "Body is not valid JUnit XML");
  }
  if (suites.length === 0) {
    throw new ApiError("invalid_report", "No <testsuite> elements found in the report");
  }
  return suites;
}

/**
 * Ingests one uploaded JUnit report, idempotent on (repo, run id, attempt, report key): a repeat returns the
 * original counts and writes nothing. The run row, report row and all results commit together or not at all.
 */
export async function ingestReport(db: AnyDb, input: IngestReportInput): Promise<IngestReportResult> {
  const suites = parseReport(input.xml);
  const counts = summarizeSuites(suites);
  const headSha = input.headSha.toLowerCase();

  return db.transaction(async (tx) => {
    // Never overwrite a run row that already exists (e.g. created by the webhook path).
    const [inserted] = await tx
      .insert(workflowRuns)
      .values({
        repoId: input.repoId,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.attempt,
        workflowName: input.workflowName,
        headSha,
        headBranch: input.headBranch,
        status: "completed",
      })
      .onConflictDoNothing()
      .returning();

    const run =
      inserted ??
      (
        await tx
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.repoId, input.repoId),
              eq(workflowRuns.githubRunId, input.githubRunId),
              eq(workflowRuns.githubRunAttempt, input.attempt),
            ),
          )
      )[0];
    if (!run) throw new Error("Failed to resolve workflow_runs row");

    if (run.headSha.toLowerCase() !== headSha) {
      throw new ApiError("validation_error", "X-FH-Sha does not match the commit already recorded for this run", [
        { path: "headers.x-fh-sha", message: `run ${input.githubRunId} is recorded against ${run.headSha}` },
      ]);
    }

    const runInfo = { id: run.id, githubRunId: run.githubRunId, attempt: run.githubRunAttempt, headSha: run.headSha };

    const [report] = await tx
      .insert(reports)
      .values({
        runId: run.id,
        reportKey: input.reportKey,
        suiteCount: counts.suites,
        testCount: counts.tests,
        passedCount: counts.passed,
        failedCount: counts.failed,
        errorCount: counts.error,
        skippedCount: counts.skipped,
      })
      .onConflictDoNothing()
      .returning({ id: reports.id });

    if (!report) {
      const [existing] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.runId, run.id), eq(reports.reportKey, input.reportKey)));
      if (!existing) throw new Error("Failed to resolve reports row");
      return {
        run: runInfo,
        duplicate: true,
        counts: {
          suites: existing.suiteCount,
          tests: existing.testCount,
          passed: existing.passedCount,
          failed: existing.failedCount,
          error: existing.errorCount,
          skipped: existing.skippedCount,
        },
      };
    }

    await insertParsedSuites(tx, { runId: run.id, repoId: input.repoId, headSha, suites });
    return { run: runInfo, duplicate: false, counts };
  });
}
