import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { createTestDb } from "../../test/testDb.js";
import { reports, repos, workflowRuns } from "../db/schema.js";
import type { GithubClient } from "../github/client.js";
import { processWorkflowRun } from "./processWorkflowRun.js";

const JUNIT_XML = `
  <testsuite name="Suite1">
    <testcase classname="pkg.Foo" name="flaky test" time="0.01" />
  </testsuite>
`;

function fakeGithubClient(zipBuffer: Uint8Array): GithubClient {
  return {
    rest: {
      actions: {
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [{ id: 1, name: "junit-results", size_in_bytes: zipBuffer.length }] },
        }),
        downloadArtifact: async () => ({ data: zipBuffer.buffer }),
      },
    },
  } as unknown as GithubClient;
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

        let downloads = 0;
        const client = fakeGithubClient(zipSync({ "junit.xml": strToU8(JUNIT_XML) }));
        const original = client.rest.actions.downloadArtifact;
        client.rest.actions.downloadArtifact = (async (...args: Parameters<typeof original>) => {
          downloads++;
          return original(...args);
        }) as typeof original;

        await processWorkflowRun(db, client, { ...baseInput, repoId });

        expect(downloads).toBe(0);
        const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
        expect(rows[0]).toMatchObject({ n: 0 });
      } finally {
        await close();
      }
    });
  });
});
