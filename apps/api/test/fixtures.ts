import type { CiSource, RepoHost } from "@flakehunter/shared-types";
import { and, eq } from "drizzle-orm";
import type { ApiVersion } from "../src/api/version.js";
import { repos, testCases, testResults, testSuites, workflowRuns } from "../src/db/schema.js";
import type { TestDb } from "./testDb.js";

export async function seedRepo(
  db: TestDb,
  overrides: { host?: RepoHost; externalRepoId?: number; owner?: string; name?: string } = {},
) {
  const owner = overrides.owner ?? "acme";
  const name = overrides.name ?? "widgets";
  const [repo] = await db
    .insert(repos)
    .values({
      host: overrides.host ?? "github",
      externalRepoId: overrides.externalRepoId ?? 1,
      owner,
      name,
      fullName: `${owner}/${name}`,
    })
    .returning();
  if (!repo) throw new Error("failed to seed repo");
  return repo;
}

export async function seedRun(
  db: TestDb,
  repoId: number,
  overrides: {
    ciSource?: CiSource;
    ciRunId?: number;
    runAttempt?: number;
    headSha?: string;
    headBranch?: string;
    createdAt?: Date;
  } = {},
) {
  const [run] = await db
    .insert(workflowRuns)
    .values({
      repoId,
      ciSource: overrides.ciSource ?? "github_actions",
      ciRunId: overrides.ciRunId ?? 1,
      runAttempt: overrides.runAttempt ?? 1,
      workflowName: "CI",
      headSha: overrides.headSha ?? "a".repeat(40),
      headBranch: overrides.headBranch ?? "main",
      status: "completed",
      createdAt: overrides.createdAt,
    })
    .returning();
  if (!run) throw new Error("failed to seed run");
  return run;
}

let nextRunId = 10_000;

/**
 * Inserts one test result (creating the test case, a run and a suite as needed) so query tests can describe
 * their data as a flat list of "test X had status S on sha Y at time T".
 */
export async function seedResult(
  db: TestDb,
  repoId: number,
  input: {
    status: "passed" | "failed" | "error" | "skipped";
    headSha: string;
    classname?: string;
    name?: string;
    createdAt?: Date;
    runId?: number;
    durationSeconds?: number;
    failureMessage?: string;
    failureStack?: string;
  },
) {
  const classname = input.classname ?? "pkg.Foo";
  const name = input.name ?? "a test";

  let [testCase] = await db
    .select()
    .from(testCases)
    .where(and(eq(testCases.repoId, repoId), eq(testCases.classname, classname), eq(testCases.name, name)));
  if (!testCase) {
    [testCase] = await db.insert(testCases).values({ repoId, classname, name }).returning();
  }
  if (!testCase) throw new Error("failed to seed test case");

  const run =
    input.runId !== undefined
      ? { id: input.runId }
      : await seedRun(db, repoId, { ciRunId: nextRunId++, headSha: input.headSha, createdAt: input.createdAt });

  const [suite] = await db.insert(testSuites).values({ runId: run.id, suiteName: "suite" }).returning();
  if (!suite) throw new Error("failed to seed suite");

  const [result] = await db
    .insert(testResults)
    .values({
      testCaseId: testCase.id,
      suiteId: suite.id,
      runId: run.id,
      repoId,
      headSha: input.headSha,
      status: input.status,
      durationSeconds: input.durationSeconds?.toString(),
      failureMessage: input.failureMessage,
      failureStack: input.failureStack,
      createdAt: input.createdAt,
    })
    .returning();
  if (!result) throw new Error("failed to seed result");
  return { testCase, result, runId: run.id };
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** How a `run` object names its CI run in an API version (v2: `ciRunId` with the CI source). */
export function runIdentity(_apiVersion: ApiVersion, ciRunId: unknown, ciSource: CiSource = "github_actions") {
  return { ciRunId, ciSource };
}
