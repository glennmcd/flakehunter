import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";
import { mintRepoToken } from "../auth/repoToken.js";
import { MemoryRateLimitStore } from "./store.js";

const API_TOKEN = "rl-test-api-token";
const SHA = "e".repeat(40);
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

/** Counts how many queries the app starts, to show what a rejected request does and does not cost. */
function countingDb<T extends object>(db: T) {
  const counter = { selects: 0 };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "select") counter.selects++;
      return Reflect.get(target, property, receiver);
    },
  });
  return { db: proxy, counter };
}

async function setup(max: number) {
  const { db: realDb, close } = await createTestDb();
  const repo = await seedRepo(realDb);
  const { token } = await mintRepoToken(realDb, repo.id);
  const { db, counter } = countingDb(realDb);
  const app = await buildApp({
    db,
    logger: false,
    rateLimit: { store: new MemoryRateLimitStore(), max, windowSeconds: 60 },
  });
  const upload = (runId: number, bearer = token, ip = "203.0.113.10") =>
    app.inject({
      method: "POST",
      url: "/api/reports",
      remoteAddress: ip,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/xml",
        "x-fh-run-id": String(runId),
        "x-fh-sha": SHA,
      },
      payload: XML,
    });
  return { app, token, upload, counter, close };
}

describe("rate limit on POST /api/reports, through buildApp", () => {
  it("accepts uploads up to the limit, then answers 429 with Retry-After", async () => {
    const { upload, close } = await setup(2);
    try {
      expect((await upload(1)).statusCode).toBe(201);
      expect((await upload(2)).statusCode).toBe(201);
      const limited = await upload(3);
      expect(limited.statusCode).toBe(429);
      expect(limited.json<unknown>()).toMatchObject({ error: { code: "rate_limited" } });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it("limits each token on its own", async () => {
    const { upload, close } = await setup(1);
    try {
      expect((await upload(1)).statusCode).toBe(201);
      expect((await upload(2)).statusCode).toBe(429);
      // Another caller (different token and address) has its own budget; an invalid token is simply a 401.
      expect((await upload(3, "fh_other_token", "203.0.113.77")).statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("does not limit the read endpoints or the health check", async () => {
    const { app, upload, close } = await setup(1);
    try {
      await upload(1);
      await upload(2);
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
        const read = await app.inject({
          method: "GET",
          url: "/api/repos",
          headers: { authorization: `Bearer ${API_TOKEN}` },
        });
        expect(read.statusCode).toBe(200);
      }
    } finally {
      await close();
    }
  });

  it("stops a flood of bad tokens with 429 before it costs a database lookup", async () => {
    const { upload, counter, close } = await setup(3);
    try {
      const statuses: number[] = [];
      // A different invented token each time: only the address limit can catch this.
      for (let i = 0; i < 6; i++) statuses.push((await upload(i, `fh_guess_${i}`)).statusCode);
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
      // One lookup per request that got past the limit; none for the three that did not.
      expect(counter.selects).toBe(3);
    } finally {
      await close();
    }
  });

  it("returns 401 and 429 in the standard error body, never a body-size error", async () => {
    const { app, close } = await setup(1);
    try {
      const big = Buffer.alloc(12 * 1024 * 1024, "a");
      const send = () =>
        app.inject({
          method: "POST",
          url: "/api/reports",
          headers: { authorization: "Bearer fh_guess", "content-type": "application/xml" },
          payload: big,
        });
      const first = await send();
      expect(first.statusCode).toBe(401);
      const second = await send();
      expect(second.statusCode).toBe(429);
    } finally {
      await close();
    }
  });
});

describe("rate limit store selection", () => {
  it("refuses to start on Lambda without a table, because an in-memory count is wrong there", async () => {
    const { db, close } = await createTestDb();
    process.env.AWS_LAMBDA_FUNCTION_NAME = "flakehunter-api";
    try {
      await expect(buildApp({ db, logger: false })).rejects.toThrow("RATE_LIMIT_TABLE");
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      await close();
    }
  });

  it("starts on Lambda when a table is configured", async () => {
    const { db, close } = await createTestDb();
    process.env.AWS_LAMBDA_FUNCTION_NAME = "flakehunter-api";
    process.env.RATE_LIMIT_TABLE = "rate-limits";
    try {
      const app = await buildApp({ db, logger: false });
      expect(app.hasDecorator("uploadRateLimit")).toBe(true);
      await app.close();
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      delete process.env.RATE_LIMIT_TABLE;
      await close();
    }
  });
});
