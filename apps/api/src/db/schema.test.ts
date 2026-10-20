import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb } from "../../test/testDb.js";
import { MIGRATIONS_FOLDER } from "./migrator.js";
import { repoApiTokens, reports, repos, workflowRuns } from "./schema.js";

async function seedRun(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [repo] = await db
    .insert(repos)
    .values({ host: "github", externalRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
    .returning({ id: repos.id });
  if (!repo) throw new Error("failed to seed repo");
  const [run] = await db
    .insert(workflowRuns)
    .values({
      repoId: repo.id,
      ciSource: "github_actions",
      ciRunId: 1,
      workflowName: "CI",
      headSha: "a".repeat(40),
      status: "completed",
    })
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
      await expect((async () => db.insert(reports).values({ runId, reportKey: "unit" }))()).rejects.toThrow();
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
      const [token] = await db
        .insert(repoApiTokens)
        .values({ repoId, tokenHash: "h1", prefix: "fh_abcde" })
        .returning();
      expect(token?.revokedAt).toBeNull();
      await expect(
        (async () => db.insert(repoApiTokens).values({ repoId, tokenHash: "h1", prefix: "fh_zzzzz" }))(),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

/** A database migrated up to, but not including, `firstSkipped`, plus a function that applies the rest. */
async function migratedUntil(firstSkipped: string) {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((e) => e.tag === firstSkipped);
  if (cut < 0) throw new Error(`no migration ${firstSkipped}`);

  const partial = mkdtempSync(join(tmpdir(), "fh-migrations-"));
  mkdirSync(join(partial, "meta"));
  const kept = journal.entries.slice(0, cut);
  for (const { tag } of kept) copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(partial, `${tag}.sql`));
  writeFileSync(join(partial, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));

  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: partial });
  return {
    client,
    // The migrator applies only entries newer than the last one recorded, so this runs the skipped ones.
    migrateRest: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: async () => {
      await client.close();
      rmSync(partial, { recursive: true });
    },
  };
}

/** The error message of a statement that fails, or null when it succeeds. */
async function failure(client: PGlite, statement: string): Promise<string | null> {
  const err = await client.exec(statement).then(
    () => null,
    (e: unknown) => e,
  );
  return err === null ? null : (err as Error).message;
}

function insertRepo(host: string, externalId: number, fullName: string) {
  const [owner, name] = fullName.split("/");
  return `insert into repos (host, github_repo_id, owner, name, full_name) values ('${host}', ${externalId}, '${owner}', '${name}', '${fullName}')`;
}

function insertRun(ciSource: string, runId: number, attempt = 1) {
  return `insert into workflow_runs (repo_id, ci_source, github_run_id, github_run_attempt, workflow_name, head_sha, status)
    select id, '${ciSource}', ${runId}, ${attempt}, 'CI', 'abc', 'completed' from repos order by id limit 1`;
}

describe("migration 0003 (host and ci_source)", () => {
  it("fills rows written before it with github and github_actions", async () => {
    const t = await migratedUntil("0003_host_and_ci_source");
    try {
      await t.client.exec(`
        insert into repos (github_repo_id, owner, name, full_name) values (1, 'acme', 'widgets', 'acme/widgets');
        insert into workflow_runs (repo_id, github_run_id, workflow_name, head_sha, status)
          select id, 100, 'CI', 'abc', 'completed' from repos;
      `);

      await t.migrateRest();

      expect((await t.client.query("select host from repos")).rows).toEqual([{ host: "github" }]);
      expect((await t.client.query("select ci_source from workflow_runs")).rows).toEqual([
        { ci_source: "github_actions" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("leaves no default, so an insert that names no host or CI source fails", async () => {
    const t = await migratedUntil("0003_host_and_ci_source");
    try {
      await t.migrateRest();

      expect(
        await failure(
          t.client,
          "insert into repos (github_repo_id, owner, name, full_name) values (1, 'a', 'b', 'a/b')",
        ),
      ).toContain('"host"');
      await t.client.exec(insertRepo("github", 1, "acme/widgets"));
      expect(
        await failure(
          t.client,
          "insert into workflow_runs (repo_id, github_run_id, workflow_name, head_sha, status) select id, 1, 'CI', 'abc', 'completed' from repos",
        ),
      ).toContain('"ci_source"');
    } finally {
      await t.close();
    }
  });

  it("rejects a host or CI source outside the known values", async () => {
    const t = await migratedUntil("0003_host_and_ci_source");
    try {
      await t.migrateRest();

      expect(await failure(t.client, insertRepo("gitlab", 1, "acme/widgets"))).toContain("repos_host_check");
      await t.client.exec(insertRepo("github", 1, "acme/widgets"));
      expect(await failure(t.client, insertRun("jenkins", 1))).toContain("workflow_runs_ci_source_check");
    } finally {
      await t.close();
    }
  });

  it("keys repos by host and runs by CI source", async () => {
    const t = await migratedUntil("0003_host_and_ci_source");
    try {
      await t.migrateRest();
      // Only one host and one CI source exist, so lift the checks to show what the keys allow once there are more.
      await t.client.exec(`
        alter table repos drop constraint repos_host_check;
        alter table workflow_runs drop constraint workflow_runs_ci_source_check;
      `);

      await t.client.exec(insertRepo("github", 1, "acme/widgets"));
      expect(await failure(t.client, insertRepo("github", 1, "acme/other"))).toContain(
        "repos_host_github_repo_id_unique",
      );
      expect(await failure(t.client, insertRepo("github", 2, "acme/widgets"))).toContain("repos_host_full_name_unique");
      expect(await failure(t.client, insertRepo("gitlab", 1, "acme/widgets"))).toBeNull();

      await t.client.exec(insertRun("github_actions", 100));
      expect(await failure(t.client, insertRun("github_actions", 100))).toContain("workflow_runs_run_key_unique");
      expect(await failure(t.client, insertRun("jenkins", 100))).toBeNull();
      expect(await failure(t.client, insertRun("github_actions", 100, 2))).toBeNull();
    } finally {
      await t.close();
    }
  });
});
