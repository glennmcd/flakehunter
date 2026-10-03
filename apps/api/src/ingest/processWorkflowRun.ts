import { eq, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { reports, workflowRuns } from "../db/schema.js";
import { downloadArtifactZip, listRunArtifacts } from "../github/artifacts.js";
import type { GithubClient } from "../github/client.js";
import { insertParsedSuites, summarizeSuites } from "./insertParsedSuites.js";
import { parseJunitXml } from "./junitParser.js";
import { ArtifactRejectedError, MAX_ARTIFACT_ZIP_BYTES } from "./limits.js";
import { extractXmlFiles } from "./zipExtract.js";

/** Report key used for results ingested from a GitHub artifact, so uploads can use their own keys. */
export const WEBHOOK_REPORT_KEY = "webhook-artifact";

export interface WorkflowRunInput {
  repoId: number;
  owner: string;
  repo: string;
  githubRunId: number;
  githubRunAttempt: number;
  workflowName: string;
  headSha: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  htmlUrl: string | null;
}

export async function processWorkflowRun(db: AnyDb, github: GithubClient, input: WorkflowRunInput): Promise<void> {
  const [run] = await db
    .insert(workflowRuns)
    .values({
      repoId: input.repoId,
      githubRunId: input.githubRunId,
      githubRunAttempt: input.githubRunAttempt,
      workflowName: input.workflowName,
      headSha: input.headSha,
      headBranch: input.headBranch,
      status: input.status,
      conclusion: input.conclusion,
      runStartedAt: input.runStartedAt ? new Date(input.runStartedAt) : null,
      runCompletedAt: input.runCompletedAt ? new Date(input.runCompletedAt) : null,
      htmlUrl: input.htmlUrl,
    })
    .onConflictDoUpdate({
      target: [workflowRuns.repoId, workflowRuns.githubRunId, workflowRuns.githubRunAttempt],
      set: {
        status: input.status,
        conclusion: input.conclusion,
        runCompletedAt: input.runCompletedAt ? new Date(input.runCompletedAt) : null,
      },
    })
    .returning({ id: workflowRuns.id });

  if (!run) throw new Error("Failed to upsert workflow_runs row");

  // An upload (or an earlier delivery of this webhook) already ingested results for this run.
  const [existingReport] = await db.select({ id: reports.id }).from(reports).where(eq(reports.runId, run.id)).limit(1);
  if (existingReport) return;

  const artifacts = await listRunArtifacts(github, {
    owner: input.owner,
    repo: input.repo,
    runId: input.githubRunId,
  });

  const artifact = artifacts.find((a) => !a.expired);
  if (!artifact) {
    await db.update(workflowRuns).set({ artifactsFetchedAt: sql`now()` }).where(eq(workflowRuns.id, run.id));
    return;
  }
  // The artifact is whatever the workflow uploaded, so refuse a large one before downloading it.
  if (artifact.sizeInBytes > MAX_ARTIFACT_ZIP_BYTES) {
    throw new ArtifactRejectedError(`artifact is larger than ${MAX_ARTIFACT_ZIP_BYTES} bytes`);
  }

  const zipBuffer = await downloadArtifactZip(github, {
    owner: input.owner,
    repo: input.repo,
    artifactId: artifact.id,
    maxBytes: MAX_ARTIFACT_ZIP_BYTES,
  });

  const suites = extractXmlFiles(new Uint8Array(zipBuffer)).flatMap((xmlFile) =>
    parseJunitXml(xmlFile.contents, xmlFile.fileName),
  );
  const counts = summarizeSuites(suites);

  await db.transaction(async (tx) => {
    const [report] = await tx
      .insert(reports)
      .values({
        runId: run.id,
        reportKey: WEBHOOK_REPORT_KEY,
        suiteCount: counts.suites,
        testCount: counts.tests,
        passedCount: counts.passed,
        failedCount: counts.failed,
        errorCount: counts.error,
        skippedCount: counts.skipped,
      })
      .onConflictDoNothing()
      .returning({ id: reports.id });

    // Lost a race with a concurrent delivery or upload: their results stand, ours are dropped.
    if (!report) return;

    await insertParsedSuites(tx, { runId: run.id, repoId: input.repoId, headSha: input.headSha, suites });
    await tx.update(workflowRuns).set({ artifactsFetchedAt: sql`now()` }).where(eq(workflowRuns.id, run.id));
  });
}
