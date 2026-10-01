import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildApp } from "../../../api/src/app";
import { daysAgo, seedRepo, seedResult, sha } from "../../../api/test/fixtures";
import { createTestDb } from "../../../api/test/testDb";
import { ApiClientError, createApiClient } from "./api";

// Contract test: the real API (in-memory database) served over loopback HTTP, called through the real client with
// the shared Zod schemas. If the API's responses and the shared schemas ever disagree, this fails.

const API_TOKEN = "contract-test-read-token";

const saved = { ...process.env };
let close: () => Promise<void>;
let baseUrl: string;
let repoId: number;
let testId: number;

beforeAll(async () => {
  process.env.API_TOKEN = API_TOKEN;
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

  const { db, close: closeDb } = await createTestDb();
  const repo = await seedRepo(db, { owner: "acme", name: "widgets" });
  repoId = repo.id;

  // One test that passes and fails on the same commit (flaky), plus a stable one.
  for (const n of [1, 2]) {
    const when = daysAgo(n);
    const first = await seedResult(db, repo.id, {
      name: "flaky one",
      status: "passed",
      headSha: sha(n),
      createdAt: when,
      durationSeconds: 0.5,
    });
    testId = first.testCase.id;
    await seedResult(db, repo.id, {
      name: "flaky one",
      status: "failed",
      headSha: sha(n),
      createdAt: when,
      failureMessage: "boom",
      failureStack: "at secret.frame",
    });
    await seedResult(db, repo.id, { name: "steady", status: "passed", headSha: sha(n), createdAt: when });
  }

  const app = await buildApp({ db, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  close = async () => {
    await app.close();
    await closeDb();
  };
});

afterAll(async () => {
  await close();
  process.env = saved;
});

const client = () => createApiClient({ apiBaseUrl: baseUrl, apiToken: API_TOKEN });

async function failure(promise: Promise<unknown>): Promise<ApiClientError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiClientError);
  return err as ApiClientError;
}

describe("client against the real API", () => {
  it("lists repos", async () => {
    const result = await client().listRepos();
    expect(result.data).toEqual([{ id: repoId, fullName: "acme/widgets", owner: "acme", name: "widgets" }]);
    expect(result.page).toEqual({ limit: 50, offset: 0, total: 1 });
  });

  it("returns the repo summary", async () => {
    const result = await client().getRepoSummary(repoId);
    expect(result.repo).toEqual({ id: repoId, fullName: "acme/widgets" });
    expect(result.totals).toMatchObject({ tests: 2, results: 6, flakyTests: 1, flakyShas: 2 });
    expect(result.totals.passRate).toBeCloseTo(0.667, 2);
    expect(typeof result.lastRunAt).toBe("string");
  });

  it("ranks flaky tests, by owner/name and by id", async () => {
    const byName = await client().getFlakyTests({ repo: "acme/widgets", minRuns: 1 });
    expect(byName.data).toHaveLength(1);
    expect(byName.data[0]).toMatchObject({ testId, name: "flaky one", shasRun: 2, flakyShas: 2, flakeRate: 1 });

    const byId = await client().getFlakyTests({ repo: repoId, minRuns: 1, since: daysAgo(30) });
    expect(byId).toEqual(byName);
  });

  it("returns a test's history and applies filters", async () => {
    const all = await client().getTestHistory(testId);
    expect(all.test).toMatchObject({ id: testId, repoId, name: "flaky one" });
    expect(all.page.total).toBe(4);
    expect(all.data[0]?.run.workflowName).toBe("CI");
    expect(JSON.stringify(all)).not.toContain("secret.frame");

    const failed = await client().getTestHistory(testId, { status: "failed" });
    expect(failed.data.map((d) => d.status)).toEqual(["failed", "failed"]);
    expect(failed.data[0]?.failureMessage).toBe("boom");
  });
});

describe("error paths against the real API", () => {
  it("maps a missing repo to not_found with a request id", async () => {
    const err = await failure(client().getRepoSummary(999));
    expect(err).toMatchObject({ code: "not_found", status: 404 });
    expect(err.requestId).toBeTruthy();
  });

  it("maps invalid parameters to validation_error with details", async () => {
    const err = await failure(client().listRepos({ limit: 999 }));
    expect(err).toMatchObject({ code: "validation_error", status: 400 });
    expect(err.details?.[0]?.path).toContain("limit");
  });

  it("maps a wrong token to unauthorized without echoing it", async () => {
    const wrong = createApiClient({ apiBaseUrl: baseUrl, apiToken: "not-the-token" });
    const err = await failure(wrong.listRepos());
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
    expect(err.message).not.toContain("not-the-token");
  });

  it("reports an unreachable API as network", async () => {
    const err = await failure(createApiClient({ apiBaseUrl: "http://127.0.0.1:1", apiToken: API_TOKEN }).listRepos());
    expect(err).toMatchObject({ code: "network", status: 0 });
  });
});
