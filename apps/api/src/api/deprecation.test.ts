import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { InjectOptions } from "fastify";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";
import { mintRepoToken } from "../auth/repoToken.js";
import { MemoryRateLimitStore } from "../ratelimit/store.js";
import { V1_DEPRECATED_AT, V1_DEPRECATION_HEADERS } from "./version.js";

const API_TOKEN = "deprecation-test-api-token";
const SHA = "d".repeat(40);
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

async function setup(max = 1000) {
  const { db, close: closeDb } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  const app = await buildApp({
    db,
    logger: false,
    rateLimit: { store: new MemoryRateLimitStore(), max, windowSeconds: 60 },
  });
  const read = { authorization: `Bearer ${API_TOKEN}` };
  const upload = (url: string, runId: number, payload = XML, bearer = token): InjectOptions => ({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/xml",
      "x-fh-run-id": String(runId),
      "x-fh-sha": SHA,
    },
    payload,
  });
  const close = async () => {
    await app.close();
    await closeDb();
  };
  return { app, repo, read, upload, close };
}

function expectDeprecated(res: { headers: Record<string, unknown> }) {
  expect(res.headers.deprecation).toBe(V1_DEPRECATION_HEADERS.deprecation);
  expect(res.headers.link).toBe(V1_DEPRECATION_HEADERS.link);
}

describe("v1 deprecation headers", () => {
  it("are the RFC 9745 date form and the two links", () => {
    expect(V1_DEPRECATION_HEADERS.deprecation).toBe(`@${V1_DEPRECATED_AT.getTime() / 1000}`);
    expect(V1_DEPRECATION_HEADERS.link).toBe(
      '</openapi.v2.json>; rel="successor-version", </docs/v2>; rel="deprecation"',
    );
  });

  it("are on every v1 response: successes, 401s, 400s and 422s", async () => {
    const { app, repo, read, upload, close } = await setup();
    try {
      const cases: [InjectOptions, number][] = [
        [{ method: "GET", url: "/api/repos", headers: read }, 200],
        [{ method: "GET", url: `/api/repos/${repo.id}/summary`, headers: read }, 200],
        [{ method: "GET", url: `/api/tests/flaky?repo=${repo.id}`, headers: read }, 200],
        [{ method: "GET", url: "/api/tests/999/history", headers: read }, 404],
        [{ method: "GET", url: "/api/tests/999/failures", headers: read }, 404],
        [{ method: "GET", url: "/api/tests/flaky", headers: read }, 400],
        [{ method: "GET", url: "/api/repos" }, 401],
        [upload("/api/reports", 1), 201],
        [upload("/api/reports", 2, "not xml"), 422],
        [upload("/api/reports", 3, XML, "wrong-token"), 401],
      ];
      for (const [request, status] of cases) {
        const res = await app.inject(request);
        expect(`${request.url} ${res.statusCode}`).toBe(`${request.url} ${status}`);
        expectDeprecated(res);
      }
    } finally {
      await close();
    }
  });

  it("are on a v1 429", async () => {
    const { app, upload, close } = await setup(1);
    try {
      expect((await app.inject(upload("/api/reports", 1))).statusCode).toBe(201);
      const limited = await app.inject(upload("/api/reports", 2));
      expect(limited.statusCode).toBe(429);
      expectDeprecated(limited);
    } finally {
      await close();
    }
  });

  it("are not on v2, health, the webhook, the week-1 routes, the specs or the docs pages", async () => {
    const { app, repo, read, upload, close } = await setup();
    try {
      const requests: InjectOptions[] = [
        { method: "GET", url: "/api/v2/repos", headers: read },
        { method: "GET", url: "/api/v2/repos" },
        { method: "GET", url: "/api/v2/tests/flaky", headers: read },
        upload("/api/v2/reports", 1),
        upload("/api/v2/reports", 2, "not xml"),
        { method: "GET", url: "/health" },
        { method: "POST", url: "/webhooks/github", payload: {} },
        { method: "GET", url: `/repos/${repo.id}/flaky-tests`, headers: read },
        { method: "GET", url: "/openapi.json" },
        { method: "GET", url: "/openapi.v2.json" },
        { method: "GET", url: "/docs" },
        { method: "GET", url: "/docs/v2" },
        { method: "GET", url: "/api/no-such-route", headers: read },
      ];
      for (const request of requests) {
        const res = await app.inject(request);
        expect(`${request.url} ${res.headers.deprecation}`).toBe(`${request.url} undefined`);
        expect(res.headers.link).toBeUndefined();
      }
    } finally {
      await close();
    }
  });
});
