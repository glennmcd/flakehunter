import { sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import type { GithubClient } from "../github/client.js";
import { testCases, testResults, testSuites, workflowRuns } from "../db/schema.js";
import { downloadArtifactZip, listRunArtifacts } from "../github/artifacts.js";
import { extractXmlFiles } from "./zipExtract.js";
import { parseJunitXml } from "./junitParser.js";

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

  const artifacts = await listRunArtifacts(github, {
    owner: input.owner,
    repo: input.repo,
    runId: input.githubRunId,
  });

  const artifact = artifacts[0];
  if (!artifact) {
    await db.update(workflowRuns).set({ artifactsFetchedAt: sql`now()` }).where(sql`${workflowRuns.id} = ${run.id}`);
    return;
  }

  const zipBuffer = await downloadArtifactZip(github, {
    owner: input.owner,
    repo: input.repo,
    artifactId: artifact.id,
  });

  const xmlFiles = extractXmlFiles(new Uint8Array(zipBuffer));

  for (const xmlFile of xmlFiles) {
    const suites = parseJunitXml(xmlFile.contents, xmlFile.fileName);

    for (const suite of suites) {
      const [suiteRow] = await db
        .insert(testSuites)
        .values({
          runId: run.id,
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
          runId: run.id,
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

  await db.update(workflowRuns).set({ artifactsFetchedAt: sql`now()` }).where(sql`${workflowRuns.id} = ${run.id}`);
}
