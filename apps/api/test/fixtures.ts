import { repos, workflowRuns } from "../src/db/schema.js";
import type { TestDb } from "./testDb.js";

export async function seedRepo(db: TestDb, overrides: { githubRepoId?: number; owner?: string; name?: string } = {}) {
  const owner = overrides.owner ?? "acme";
  const name = overrides.name ?? "widgets";
  const [repo] = await db
    .insert(repos)
    .values({ githubRepoId: overrides.githubRepoId ?? 1, owner, name, fullName: `${owner}/${name}` })
    .returning();
  if (!repo) throw new Error("failed to seed repo");
  return repo;
}

export async function seedRun(
  db: TestDb,
  repoId: number,
  overrides: { githubRunId?: number; githubRunAttempt?: number; headSha?: string; headBranch?: string } = {},
) {
  const [run] = await db
    .insert(workflowRuns)
    .values({
      repoId,
      githubRunId: overrides.githubRunId ?? 1,
      githubRunAttempt: overrides.githubRunAttempt ?? 1,
      workflowName: "CI",
      headSha: overrides.headSha ?? "a".repeat(40),
      headBranch: overrides.headBranch ?? "main",
      status: "completed",
    })
    .returning();
  if (!run) throw new Error("failed to seed run");
  return run;
}
