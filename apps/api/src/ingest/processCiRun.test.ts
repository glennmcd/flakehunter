import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { createTestDb } from "../../test/testDb.js";
import type { CiRepo, CiSource, CiSourceAdapter, RepoHost, ReportArtifact } from "../ci/types.js";
import { reports, repos, workflowRuns } from "../db/schema.js";
import { ArtifactRejectedError, MAX_ARTIFACT_ZIP_BYTES } from "./limits.js";
import { type CiRunInput, processCiRun } from "./processCiRun.js";

const JUNIT_XML = `
  <testsuite name="Suite1">
    <testcase classname="pkg.Foo" name="flaky test" time="0.01" />
  </testsuite>
`;

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

/** A CI adapter serving one zip. `downloads` records each download's artifact id and size limit. */
function fakeAdapter(zip: Uint8Array, artifacts?: ReportArtifact[]) {
  const downloads: { artifactId: number; maxBytes: number }[] = [];
  const adapter = {
    ciSource: "github_actions" as CiSource,
    hosts: new Set<RepoHost>(["github"]) as ReadonlySet<RepoHost>,
    listRunArtifacts: async (_repo: CiRepo, _runId: number) =>
      artifacts ?? [{ id: 1, name: "junit-results", sizeInBytes: zip.length, expired: false }],
    downloadArtifact: async (_repo: CiRepo, artifactId: number, maxBytes: number) => {
      downloads.push({ artifactId, maxBytes });
      return zip;
    },
  } satisfies CiSourceAdapter;
  return Object.assign(adapter, { downloads });
}

async function seedRepo(db: TestDb): Promise<CiRepo> {
  const [repo] = await db
    .insert(repos)
    .values({ host: "github", externalRepoId: 1, owner: "acme", name: "widgets", fullName: "acme/widgets" })
    .returning({ id: repos.id });
  if (!repo) throw new Error("failed to seed repo");
  return { id: repo.id, host: "github", externalRepoId: 1, owner: "acme", name: "widgets" };
}

function runInput(repo: CiRepo, overrides: Partial<CiRunInput> = {}): CiRunInput {
  return {
    repo,
    ciSource: "github_actions",
    runId: 100,
    attempt: 1,
    workflowName: "CI",
    headSha: "abc123",
    headBranch: "main",
    status: "completed",
    conclusion: "success",
    runStartedAt: null,
    runCompletedAt: null,
    htmlUrl: null,
    ...overrides,
  };
}

async function withRepo(run: (db: TestDb, repo: CiRepo) => Promise<void>) {
  const { db, close } = await createTestDb();
  try {
    await run(db, await seedRepo(db));
  } finally {
    await close();
  }
}

async function countRows(db: TestDb) {
  const { rows } = await db.execute(
    sql`select (select count(*)::int from reports) as reports, (select count(*)::int from test_results) as results`,
  );
  return rows[0];
}

const zip = zipSync({ "junit.xml": strToU8(JUNIT_XML) });

describe("processCiRun", () => {
  it("persists suites/cases/results and flags a test flaky when it both passes and fails on the same SHA", async () => {
    await withRepo(async (db, repo) => {
      // Run 1 on SHA abc123: the test passes.
      await processCiRun(db, fakeAdapter(zip), runInput(repo, { runId: 100 }));

      const failingXml = `
        <testsuite name="Suite1">
          <testcase classname="pkg.Foo" name="flaky test" time="0.02">
            <failure message="boom">stack</failure>
          </testcase>
        </testsuite>
      `;
      const failingZip = zipSync({ "junit.xml": strToU8(failingXml) });

      // Run 2, same SHA, different run id: the test fails this time.
      await processCiRun(db, fakeAdapter(failingZip), runInput(repo, { runId: 101, conclusion: "failure" }));

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
    });
  });

  describe("adapter checks", () => {
    it("refuses an adapter for another CI source before touching the database", async () => {
      await withRepo(async (db, repo) => {
        const adapter = Object.assign(fakeAdapter(zip), { ciSource: "other_ci" as CiSource });

        const err = await processCiRun(db, adapter, runInput(repo)).catch((e: unknown) => e);

        expect((err as Error).message).toBe("the other_ci adapter cannot fetch a github_actions run");
        expect(adapter.downloads).toEqual([]);
        expect(await db.select().from(workflowRuns)).toEqual([]);
      });
    });

    it("refuses an adapter that cannot fetch for the repository's host", async () => {
      await withRepo(async (db, repo) => {
        const adapter = Object.assign(fakeAdapter(zip), { hosts: new Set<RepoHost>() as ReadonlySet<RepoHost> });

        const err = await processCiRun(db, adapter, runInput(repo)).catch((e: unknown) => e);

        expect((err as Error).message).toBe("the github_actions adapter cannot fetch for a github repository");
        expect(await db.select().from(workflowRuns)).toEqual([]);
      });
    });

    it("passes the registered repo and run id to the adapter", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip);
        const listed: [CiRepo, number][] = [];
        const list = adapter.listRunArtifacts;
        adapter.listRunArtifacts = async (r, runId) => {
          listed.push([r, runId]);
          return list(r, runId);
        };

        await processCiRun(db, adapter, runInput(repo, { runId: 4242 }));

        expect(listed).toEqual([[repo, 4242]]);
      });
    });
  });

  describe("idempotency", () => {
    it("does not double count when the same run is processed twice (webhook redelivery)", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip);

        await processCiRun(db, adapter, runInput(repo, { runId: 200 }));
        await processCiRun(db, adapter, runInput(repo, { runId: 200 }));

        const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
        expect(rows[0]).toMatchObject({ n: 1 });
        const { rows: suites } = await db.execute(sql`select count(*)::int as n from test_suites`);
        expect(suites[0]).toMatchObject({ n: 1 });
      });
    });

    it("skips artifact ingestion when an upload already recorded a report for the run", async () => {
      await withRepo(async (db, repo) => {
        const [run] = await db
          .insert(workflowRuns)
          .values({
            repoId: repo.id,
            ciSource: "github_actions",
            ciRunId: 200,
            runAttempt: 1,
            workflowName: "upload",
            headSha: "def456",
            status: "completed",
          })
          .returning({ id: workflowRuns.id });
        if (!run) throw new Error("failed to seed run");
        await db.insert(reports).values({ runId: run.id, reportKey: "default" });

        const adapter = fakeAdapter(zip);

        await processCiRun(db, adapter, runInput(repo, { runId: 200, headSha: "def456" }));

        expect(adapter.downloads).toEqual([]);
        const { rows } = await db.execute(sql`select count(*)::int as n from test_results`);
        expect(rows[0]).toMatchObject({ n: 0 });
      });
    });
  });

  describe("artifact limits", () => {
    it("refuses an artifact listed over the size limit without downloading it", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip, [
          { id: 7, name: "huge", sizeInBytes: MAX_ARTIFACT_ZIP_BYTES + 1, expired: false },
        ]);

        const err = await processCiRun(db, adapter, runInput(repo)).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect(adapter.downloads).toEqual([]);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("skips expired artifacts and downloads the first one still available, with the size limit", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip, [
          { id: 1, name: "old", sizeInBytes: zip.length, expired: true },
          { id: 2, name: "junit-results", sizeInBytes: zip.length, expired: false },
        ]);

        await processCiRun(db, adapter, runInput(repo));

        expect(adapter.downloads).toEqual([{ artifactId: 2, maxBytes: MAX_ARTIFACT_ZIP_BYTES }]);
        expect(await countRows(db)).toMatchObject({ reports: 1, results: 1 });
      });
    });

    it("records the run as fetched, with nothing ingested, when every artifact has expired", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip, [{ id: 1, name: "old", sizeInBytes: zip.length, expired: true }]);

        await processCiRun(db, adapter, runInput(repo));

        expect(adapter.downloads).toEqual([]);
        const [run] = await db.select().from(workflowRuns);
        expect(run?.artifactsFetchedAt).not.toBeNull();
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("stores nothing when the adapter rejects the download", async () => {
      await withRepo(async (db, repo) => {
        const adapter = fakeAdapter(zip);
        adapter.downloadArtifact = async () => {
          throw new ArtifactRejectedError(`artifact download exceeds ${MAX_ARTIFACT_ZIP_BYTES} bytes`);
        };

        const err = await processCiRun(db, adapter, runInput(repo)).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });

    it("stores nothing when the artifact is a decompression bomb", async () => {
      await withRepo(async (db, repo) => {
        const bomb = zipSync({ "bomb.xml": new Uint8Array(64 * 1024 * 1024) });

        const err = await processCiRun(db, fakeAdapter(bomb), runInput(repo)).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ArtifactRejectedError);
        expect(await countRows(db)).toMatchObject({ reports: 0, results: 0 });
      });
    });
  });
});
