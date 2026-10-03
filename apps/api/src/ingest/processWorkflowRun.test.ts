import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { createTestDb } from "../../test/testDb.js";
import { reports, repos, workflowRuns } from "../db/schema.js";
import type { GithubClient } from "../github/client.js";
import { ArtifactRejectedError, MAX_ARTIFACT_ZIP_BYTES } from "./limits.js";
import { processWorkflowRun } from "./processWorkflowRun.js";

const JUNIT_XML = `
  <testsuite name="Suite1">
    <testcase classname="pkg.Foo" name="flaky test" time="0.01" />
  </testsuite>
`;

interface FakeArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

/** A GitHub client serving one zip. `downloads` records the artifact ids downloaded. */
function fakeGithubClient(zipBuffer: Uint8Array, artifacts?: FakeArtifact[]) {
  const downloads: number[] = [];
  const client = {
    rest: {
      actions: {
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: artifacts ?? [{ id: 1, name: "junit-results", size_in_bytes: zipBuffer.length, expired: false }],
          },
        }),
        downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => {
          downloads.push(artifact_id);
          return { data: zipBuffer.buffer };
        },
      },
    },
  } as unknown as GithubClient;
  return Object.assign(client, { downloads });
}

describe("processWorkflowRun", () => {
  it("persists suites/cases/results and flags a test flaky when it both passes and fails on the same SHA", async () => {
    const { db, close } = await createTestDb();
    try {
      const [repo] = await db
        .insert(repos)
        .values({ githubRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
        .returning({ id: repos.id });
      if (!repo) throw new Error("failed to seed repo");

      const zip = zipSync({ "junit.xml": strToU8(JUNIT_XML) });

      // Run 1 on SHA abc123: the test passes (random() gate not present in this fixture, so we
      // control pass/fail by swapping the XML content between "runs").
      await processWorkflowRun(db, fakeGithubClient(zip), {
        repoId: repo.id,
        owner: "acme",
        repo: "widgets",
        githubRunId: 100,
        githubRunAttempt: 1,
        workflowName: "CI",
        headSha: "abc123",
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        runStartedAt: null,
        runCompletedAt: null,
        htmlUrl: null,
      });

      const failingXml = `
        <testsuite name="Suite1">
          <testcase classname="pkg.Foo" name="flaky test" time="0.02">
            <failure message="boom">stack</failure>
          </testcase>
        </testsuite>
      `;
      const failingZip = zipSync({ "junit.xml": strToU8(failingXml) });

      // Run 2, same SHA, different run id: the test fails this time.
      await processWorkflowRun(db, fakeGithubClient(failingZip), {
        repoId: repo.id,
        owner: "acme",
        repo: "widgets",
        githubRunId: 101,
        githubRunAttempt: 1,
        workflowName: "CI",
        headSha: "abc123",
        headBranch: "main",
        status: "completed",
        conclusion: "failure",
        runStartedAt: null,
        runCompletedAt: null,
        htmlUrl: null,
      });

      const { rows: flaky } = await db.execute(
        sql`select classname, name, head_sha, pass_count, fail_count from flaky_tests`,
      );
      expect(flaky).toHaveLength(1);
      expect(flaky[0]).toMatchObject({
        classname: "pkg.Foo",
        name: "flaky test",
        head_sha: "abc123",
        pass_count: 1,
        fail_count: 1,
      });
    } finally {
      await close();
    }
  });

  describe("idempotency", () => {
    const baseInput = {
      owner: "acme",
      repo: "widgets",
      githubRunId: 200,
      githubRunAttempt: 1,
      workflowName: "CI",
      headSha: "def456",
      headBranch: "main",
      status: "completed",
      conclusion: "success",
      runStartedAt: null,
      runCompletedAt: null,
      htmlUrl: null,
    };

    async function seedRepo(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
      const [repo] = await db
        .insert(repos)
        .values({ githubRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
        .returning({ id: repos.id });
      if (!repo) throw new Error("failed to seed repo");
      return repo.id;
    }

    it("does not double count when the same run is processed twice (webhook redelivery)", async () => {
      const { db, close } = await createTestDb();
      try {
        const repoId = await seedRepo(db);
        const client = fakeGithubClient(zipSync({ "junit.xml": strToU8(JUNIT_XML) }));

        await processWorkflowRun(db, client, { ...baseInput, repoId });
        await processWorkflowRun(db, client, { ...baseInput, repoId });

        const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
        expect(rows[0]).toMatchObject({ n: 1 });
        const { rows: suites } = await db.execute(sql`select count(*)::int as n from test_suites`);
        expect(suites[0]).toMatchObject({ n: 1 });
      } finally {
        await close();
      }
    });

    it("skips artifact ingestion when an upload already recorded a report for the run", async () => {
      const { db, close } = await createTestDb();
      try {
        const repoId = await seedRepo(db);
        const [run] = await db
          .insert(workflowRuns)
          .values({
            repoId,
            githubRunId: baseInput.githubRunId,
            githubRunAttempt: 1,
            workflowName: "upload",
            headSha: baseInput.headSha,
            status: "completed",
          })
          .returning({ id: workflowRuns.id });
        if (!run) throw new Error("failed to seed run");
        await db.insert(reports).values({ runId: run.id, reportKey: "default" });

        const client = fakeGithubClient(zipSync({ "junit.xml": strToU8(JUNIT_XML) }));

        await processWorkflowRun(db, client, { ...baseInput, repoId });

        expect(client.downloads).toEqual([]);
        const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
        expect(rows[0]).toMatchObject({ n: 0 });
      } finally {
        await close();
      }
    });
  });

  describe("artifact limits", () => {
    const input = {
      owner: "acme",
      repo: "widgets",
      githubRunId: 300,
      githubRunAttempt: 1,
      workflowName: "CI",
      headSha: "fed789",
      headBranch: "main",
      status: "completed",
      conclusion: "success",
      runStartedAt: null,
      runCompletedAt: null,
      htmlUrl: null,
    };

    async function withRepo(
      run: (db: Awaited<ReturnType<typeof createTestDb>>["db"], repoId: number) => Promise<void>,
    ) {
      const { db, close } = await createTestDb();
      try {
        const [repo] = await db
          .insert(repos)
          .values({ githubRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
          .returning({ id: repos.id });
        if (!repo) throw new Error("failed to seed repo");
        await run(db, repo.id);
      } finally {
        await close();
      }
    }

    async function countRows(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
      const { rows } = await db.execute(
        sql`select (select count(*)::int from reports) as reports, (select count(*)::int from test_results) as results`,
      );
      return rows[0];
    }

    const zip = zipSync({ "junit.xml": strToU8(JUNIT_XML) });

    it("refuses an artifact listed over the size limit without downloading it", async () => {
      await withRepo(async (db, repoId) => {
        const client = fakeGithubClient(zip, [
          { id: 7, name: "huge", size_in_bytes: MAX_ARTIFACT_ZIP_BYTES + 1, expired: false },
        ]);

        const err = await processWorkflowRun(db, client, { ...input, repoId }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect(client.downloads).toEqual([]);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("skips expired artifacts and ingests the first one still available", async () => {
      await withRepo(async (db, repoId) => {
        const client = fakeGithubClient(zip, [
          { id: 1, name: "old", size_in_bytes: zip.length, expired: true },
          { id: 2, name: "junit-results", size_in_bytes: zip.length, expired: false },
        ]);

        await processWorkflowRun(db, client, { ...input, repoId });

        expect(client.downloads).toEqual([2]);
        expect(await countRows(db)).toMatchObject({ reports: 1, results: 1 });
      });
    });

    it("records the run as fetched, with nothing ingested, when every artifact has expired", async () => {
      await withRepo(async (db, repoId) => {
        const client = fakeGithubClient(zip, [{ id: 1, name: "old", size_in_bytes: zip.length, expired: true }]);

        await processWorkflowRun(db, client, { ...input, repoId });

        expect(client.downloads).toEqual([]);
        const [run] = await db.select().from(workflowRuns);
        expect(run?.artifactsFetchedAt).not.toBeNull();
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("refuses a download larger than the limit even when the listed size was small", async () => {
      await withRepo(async (db, repoId) => {
        const oversized = new Uint8Array(MAX_ARTIFACT_ZIP_BYTES + 1);
        const client = fakeGithubClient(oversized, [{ id: 3, name: "liar", size_in_bytes: 100, expired: false }]);

        const err = await processWorkflowRun(db, client, { ...input, repoId }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect((err as Error).message).toBe(`artifact download exceeds ${MAX_ARTIFACT_ZIP_BYTES} bytes`);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("refuses a download that is not binary data", async () => {
      await withRepo(async (db, repoId) => {
        const client = fakeGithubClient(zip);
        client.rest.actions.downloadArtifact = (async () => ({
          data: "<html>not a zip</html>",
        })) as unknown as typeof client.rest.actions.downloadArtifact;

        const err = await processWorkflowRun(db, client, { ...input, repoId }).catch((e: unknown) => e);

        expect((err as Error).message).toBe("artifact download was not binary data");
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("stores nothing when the artifact is a decompression bomb", async () => {
      await withRepo(async (db, repoId) => {
        const bomb = zipSync({ "bomb.xml": new Uint8Array(64 * 1024 * 1024) });
        const client = fakeGithubClient(bomb);

        const err = await processWorkflowRun(db, client, { ...input, repoId }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });
  });
});
