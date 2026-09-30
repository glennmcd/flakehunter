import { describe, expect, it } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { createTestDb } from "../../test/testDb.js";
import { repos } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { processWorkflowRun } from "./processWorkflowRun.js";
import type { GithubClient } from "../github/client.js";

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

      const { rows: flaky } = await db.execute(sql`select classname, name, head_sha, pass_count, fail_count from flaky_tests`);
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
});
