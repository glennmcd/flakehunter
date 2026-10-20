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

describe("API v1 and v2 side by side", () => {
  it.each([
    ["/api/reports", "/api/v2/reports"],
    ["/api/v2/reports", "/api/reports"],
  ])("an upload to %s and the same run to %s are one report", async (first, second) => {
    const { upload, close } = await setup();
    try {
      const created = await upload(first, 1);
      expect(created.statusCode).toBe(201);
      const repeated = await upload(second, 1);
      expect(repeated.statusCode).toBe(200);
      const [a, b] = [created.json(), repeated.json()];
      expect(b.duplicate).toBe(true);
      expect(b.run.id).toBe(a.run.id);
      expect(b.counts).toEqual(a.counts);
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

  it("takes a v1 upload, a v2 upload without X-FH-CI-Source and one naming github_actions as the same run", async () => {
    const { app, upload, close } = await setup();
    try {
      const v1 = await upload("/api/reports", 3);
      const bare = await upload("/api/v2/reports", 3);
      const named = await upload("/api/v2/reports", 3, undefined, { "x-fh-ci-source": "github_actions" });
      expect([v1.statusCode, bare.statusCode, named.statusCode]).toEqual([201, 200, 200]);
      expect(named.json().run).toEqual(bare.json().run);
      expect(bare.json().run.id).toBe(v1.json().run.id);

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
