import { describe, expect, it } from "bun:test";
import { createTestDb } from "../../test/testDb.js";
import { repoApiTokens, repos, reports, workflowRuns } from "./schema.js";

async function seedRun(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [repo] = await db
    .insert(repos)
    .values({ githubRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
    .returning({ id: repos.id });
  if (!repo) throw new Error("failed to seed repo");
  const [run] = await db
    .insert(workflowRuns)
    .values({ repoId: repo.id, githubRunId: 1, workflowName: "CI", headSha: "a".repeat(40), status: "completed" })
    .returning({ id: workflowRuns.id });
  if (!run) throw new Error("failed to seed run");
  return { repoId: repo.id, runId: run.id };
}

describe("migration 0002 (reports + repo_api_tokens)", () => {
  it("rejects a second report with the same (run_id, report_key)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { runId } = await seedRun(db);
      await db.insert(reports).values({ runId, reportKey: "unit" });
      await expect(db.insert(reports).values({ runId, reportKey: "unit" })).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("allows different report keys on one run and defaults the key to 'default'", async () => {
    const { db, close } = await createTestDb();
    try {
      const { runId } = await seedRun(db);
      const [first] = await db.insert(reports).values({ runId }).returning();
      await db.insert(reports).values({ runId, reportKey: "integration" });
      expect(first?.reportKey).toBe("default");
      expect(first?.testCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("deletes reports when their run is deleted", async () => {
    const { db, close } = await createTestDb();
    try {
      const { runId } = await seedRun(db);
      await db.insert(reports).values({ runId });
      await db.delete(workflowRuns);
      expect(await db.select().from(reports)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("enforces a unique token_hash and leaves revoked_at null by default", async () => {
    const { db, close } = await createTestDb();
    try {
      const { repoId } = await seedRun(db);
      const [token] = await db.insert(repoApiTokens).values({ repoId, tokenHash: "h1", prefix: "fh_abcde" }).returning();
      expect(token?.revokedAt).toBeNull();
      await expect(db.insert(repoApiTokens).values({ repoId, tokenHash: "h1", prefix: "fh_zzzzz" })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
