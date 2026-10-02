import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { buildApiApp } from "../../../test/apiApp.js";
import { seedRepo } from "../../../test/fixtures.js";
import { createTestDb, type TestDb } from "../../../test/testDb.js";
import { mintRepoToken } from "../../auth/repoToken.js";
import reportsRoute from "./reports.js";

const SHA = "b".repeat(40);
const MIB = 1024 * 1024;

const XML = `
<testsuite name="S1">
  <testcase classname="pkg.Foo" name="passes" time="0.1" />
  <testcase classname="pkg.Foo" name="fails"><failure message="boom">stack</failure></testcase>
</testsuite>`;

function headers(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/xml",
    "x-fh-run-id": "987",
    "x-fh-sha": SHA,
    ...extra,
  };
}

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  const app = await buildApiApp(db, [reportsRoute]);
  return { db, close, token, app };
}

async function count(db: TestDb, table: string) {
  const { rows } = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return (rows[0] as { n: number }).n;
}

describe("POST /api/reports with Content-Encoding: gzip", () => {
  const gzipHeaders = (token: string, extra: Record<string, string> = {}) =>
    headers(token, { "content-encoding": "gzip", ...extra });

  it("ingests a gzip body exactly like the plain one", async () => {
    const { db, close, token, app } = await setup();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: gzipHeaders(token),
        payload: gzipSync(XML),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ duplicate: false, counts: { suites: 1, tests: 2, passed: 1, failed: 1 } });
      expect(await count(db, "test_results")).toBe(2);

      // The same run uploaded plain is a duplicate: one idempotency key whatever the encoding.
      const plain = await app.inject({ method: "POST", url: "/api/reports", headers: headers(token), payload: XML });
      expect(plain.statusCode).toBe(200);
      expect(plain.json()).toMatchObject({ duplicate: true });
    } finally {
      await close();
    }
  });

  it("accepts x-gzip, any letter case, and an explicit identity encoding", async () => {
    const { close, token, app } = await setup();
    try {
      const upload = (runId: string, encoding: string, payload: Buffer | string) =>
        app.inject({
          method: "POST",
          url: "/api/reports",
          headers: headers(token, { "content-encoding": encoding, "x-fh-run-id": runId }),
          payload,
        });
      expect((await upload("1", "x-gzip", gzipSync(XML))).statusCode).toBe(201);
      expect((await upload("2", "GZip", gzipSync(XML))).statusCode).toBe(201);
      expect((await upload("3", "identity", XML)).statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("rejects a decompression bomb with 413 once the decompressed size passes the limit, storing nothing", async () => {
    const { db, close, token, app } = await setup();
    try {
      const bomb = gzipSync(Buffer.alloc(12 * MIB, "a"));
      expect(bomb.length).toBeLessThan(64 * 1024);
      const res = await app.inject({ method: "POST", url: "/api/reports", headers: gzipHeaders(token), payload: bomb });
      expect(res.statusCode).toBe(413);
      expect(res.json<unknown>()).toMatchObject({ error: { code: "payload_too_large" } });
      expect(await count(db, "test_results")).toBe(0);
    } finally {
      await close();
    }
  });

  it("returns 400 for data that is not gzip, and for a truncated gzip stream", async () => {
    const { close, token, app } = await setup();
    try {
      const notGzip = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: gzipHeaders(token),
        payload: XML,
      });
      expect(notGzip.statusCode).toBe(400);
      expect(notGzip.json<unknown>()).toMatchObject({
        error: { code: "validation_error", message: "Request body is not valid gzip data" },
      });

      const whole = gzipSync(XML);
      const truncated = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: gzipHeaders(token),
        payload: whole.subarray(0, whole.length - 8),
      });
      expect(truncated.statusCode).toBe(400);
      expect(truncated.json<unknown>()).toMatchObject({ error: { code: "validation_error" } });
    } finally {
      await close();
    }
  });

  it("rejects other encodings with a 400 naming the header", async () => {
    const { close, token, app } = await setup();
    try {
      for (const encoding of ["br", "deflate", "gzip, br", "gzip, gzip"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/reports",
          headers: headers(token, { "content-encoding": encoding }),
          payload: gzipSync(XML),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json<unknown>()).toMatchObject({
          error: { code: "validation_error", details: [{ path: "headers.content-encoding" }] },
        });
      }
    } finally {
      await close();
    }
  });

  it("checks the token before decompressing anything", async () => {
    const { db, close, app } = await setup();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: gzipHeaders("fh_not_a_real_token"),
        payload: gzipSync(Buffer.alloc(12 * MIB, "a")),
      });
      expect(res.statusCode).toBe(401);
      expect(await count(db, "test_results")).toBe(0);
    } finally {
      await close();
    }
  });

  it("still reports a plain body over the limit as 413", async () => {
    const { close, token, app } = await setup();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reports",
        headers: headers(token),
        payload: Buffer.alloc(12 * MIB, "a"),
      });
      expect(res.statusCode).toBe(413);
    } finally {
      await close();
    }
  });
});
