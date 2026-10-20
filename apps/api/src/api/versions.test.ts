import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";
import { mintRepoToken } from "../auth/repoToken.js";

const API_TOKEN = "versions-test-api-token";
const SHA = "f".repeat(40);
const XML = `<testsuite name="S"><testcase classname="pkg.Foo" name="a test" time="0.2"/></testsuite>`;

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = API_TOKEN;
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
  delete process.env.RATE_LIMIT_TABLE;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
});
afterAll(() => {
  process.env = saved;
});

async function setup() {
  const { db, close: closeDb } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  const app = await buildApp({ db, logger: false });
  const upload = (url: string, runId: number, bearer = token, extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/xml",
        "x-fh-run-id": String(runId),
        "x-fh-sha": SHA,
        ...extra,
      },
      payload: XML,
    });
  const close = async () => {
    await app.close();
    await closeDb();
  };
  return { app, repo, upload, close };
}

describe("the published API, through buildApp", () => {
  it("no longer serves v1, its spec or the week-1 routes, and sends /docs to the v2 docs page", async () => {
    const { app, repo, close } = await setup();
    const read = { authorization: `Bearer ${API_TOKEN}` };
    try {
      for (const url of [
        "/api/repos",
        `/api/repos/${repo.id}/summary`,
        `/api/tests/flaky?repo=${repo.id}`,
        "/api/tests/1/history",
        "/api/tests/1/failures",
        "/repos",
        `/repos/${repo.id}/flaky-tests`,
        `/repos/${repo.id}/runs`,
        `/repos/${repo.id}/tests/1/results`,
        "/openapi.json",
      ]) {
        expect((await app.inject({ method: "GET", url, headers: read })).statusCode).toBe(404);
      }
      expect((await app.inject({ method: "POST", url: "/api/reports", headers: read })).statusCode).toBe(404);

      const docs = await app.inject({ method: "GET", url: "/docs" });
      expect(docs.statusCode).toBe(302);
      expect(docs.headers.location).toBe("/docs/v2");
    } finally {
      await close();
    }
  });

  it("gates the v2 read routes with API_TOKEN, and the v2 upload with an upload token only", async () => {
    const { app, repo, upload, close } = await setup();
    try {
      for (const url of [
        "/api/v2/repos",
        `/api/v2/repos/${repo.id}/summary`,
        `/api/v2/tests/flaky?repo=${repo.id}`,
        "/api/v2/tests/1/history",
        "/api/v2/tests/1/failures",
      ]) {
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      }
      const authorized = await app.inject({
        method: "GET",
        url: "/api/v2/repos",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(authorized.statusCode).toBe(200);

      expect((await upload("/api/v2/reports", 2, API_TOKEN)).statusCode).toBe(401);
      expect((await upload("/api/v2/reports", 2)).statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("takes an upload without X-FH-CI-Source and one naming github_actions as the same run", async () => {
    const { app, upload, close } = await setup();
    try {
      const bare = await upload("/api/v2/reports", 3);
      const named = await upload("/api/v2/reports", 3, undefined, { "x-fh-ci-source": "github_actions" });
      expect([bare.statusCode, named.statusCode]).toEqual([201, 200]);
      expect(named.json().run).toEqual(bare.json().run);

      const history = await app.inject({
        method: "GET",
        url: "/api/v2/tests/1/history",
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(history.json().data.map((d: { run: unknown }) => d.run)).toEqual([
        expect.objectContaining({ ciRunId: 3, ciSource: "github_actions" }),
      ]);
    } finally {
      await close();
    }
  });
});
