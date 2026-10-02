import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Context } from "aws-lambda";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";
import { mintRepoToken } from "../auth/repoToken.js";
import { createHandler } from "./handler.js";

const SECRETS = {
  API_TOKEN: "lambda-test-api-token",
  GITHUB_PAT: "lambda-test-pat",
  GITHUB_WEBHOOK_SECRET: "lambda-test-webhook-secret",
  DATABASE_URL: "postgres://unused",
};
const SHA = "d".repeat(40);
const XML = `<testsuite name="S"><testcase classname="pkg.Foo" name="a test" time="0.2"/></testsuite>`;
const context = {} as Context;

const saved = { ...process.env };
beforeAll(() => {
  for (const name of Object.keys(SECRETS)) delete process.env[name];
});
afterAll(() => {
  process.env = saved;
});

/** An API Gateway HTTP API (payload format 2.0) event, the shape the Lambda receives in production. */
function event(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  base64?: boolean;
  query?: string;
}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: options.path,
    rawQueryString: options.query ?? "",
    // API Gateway sends the parsed parameters as well as the raw string.
    queryStringParameters: options.query ? Object.fromEntries(new URLSearchParams(options.query)) : undefined,
    headers: { "content-type": "application/json", ...options.headers },
    requestContext: { http: { method: options.method, path: options.path, sourceIp: "203.0.113.9" } },
    body: options.body,
    isBase64Encoded: options.base64 ?? false,
  };
}

async function setup() {
  const { db, close } = await createTestDb();
  const repo = await seedRepo(db);
  const { token } = await mintRepoToken(db, repo.id);
  let secretLoads = 0;
  let appBuilds = 0;
  const handler = createHandler({
    loadSecrets: async () => {
      secretLoads++;
      return SECRETS;
    },
    buildApp: () => {
      appBuilds++;
      return buildApp({ db, logger: false });
    },
  });
  const call = async (ev: ReturnType<typeof event>) => {
    const res = (await handler(ev, context)) as { statusCode: number; body: string; headers: Record<string, string> };
    return { ...res, json: () => JSON.parse(res.body) as unknown };
  };
  return { call, token, close, counts: () => ({ secretLoads, appBuilds }) };
}

describe("Lambda handler", () => {
  it("serves /health and builds the app and loads secrets once across invocations", async () => {
    const { call, close, counts } = await setup();
    try {
      const first = await call(event({ method: "GET", path: "/health" }));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });
      expect((await call(event({ method: "GET", path: "/health" }))).statusCode).toBe(200);
      expect(counts()).toEqual({ secretLoads: 1, appBuilds: 1 });
    } finally {
      await close();
    }
  });

  it("applies the loaded secrets so the auth plugin accepts the API token", async () => {
    const { call, close } = await setup();
    try {
      const denied = await call(event({ method: "GET", path: "/api/repos" }));
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toMatchObject({ error: { code: "unauthorized" } });

      const ok = await call(
        event({ method: "GET", path: "/api/repos", headers: { authorization: `Bearer ${SECRETS.API_TOKEN}` } }),
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ data: [{ fullName: "acme/widgets" }], page: { total: 1 } });
    } finally {
      await close();
    }
  });

  it("passes the query string through", async () => {
    const { call, close } = await setup();
    try {
      const res = await call(
        event({
          method: "GET",
          path: "/api/repos",
          query: "limit=1&offset=5",
          headers: { authorization: `Bearer ${SECRETS.API_TOKEN}` },
        }),
      );
      expect(res.json()).toMatchObject({ page: { limit: 1, offset: 5 } });
    } finally {
      await close();
    }
  });

  it("ingests an XML upload, as plain text and as a base64 body", async () => {
    const { call, token, close } = await setup();
    const upload = (runId: number, extra: { body: string; base64: boolean }) =>
      call(
        event({
          method: "POST",
          path: "/api/reports",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/xml",
            "x-fh-run-id": String(runId),
            "x-fh-sha": SHA,
          },
          ...extra,
        }),
      );
    try {
      expect((await upload(1, { body: XML, base64: false })).statusCode).toBe(201);
      const b64 = await upload(2, { body: Buffer.from(XML).toString("base64"), base64: true });
      expect(b64.statusCode).toBe(201);
      expect(b64.json()).toMatchObject({ duplicate: false });
    } finally {
      await close();
    }
  });

  it("ingests a gzip upload that API Gateway delivers as a base64 body, and rejects a bomb", async () => {
    const { call, token, close } = await setup();
    const upload = (runId: number, payload: Buffer) =>
      call(
        event({
          method: "POST",
          path: "/api/reports",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/xml",
            "content-encoding": "gzip",
            "x-fh-run-id": String(runId),
            "x-fh-sha": SHA,
          },
          body: payload.toString("base64"),
          base64: true,
        }),
      );
    try {
      const ok = await upload(1, gzipSync(XML));
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ duplicate: false, counts: { tests: 1, passed: 1 } });

      const bomb = await upload(2, gzipSync(Buffer.alloc(12 * 1024 * 1024, "a")));
      expect(bomb.statusCode).toBe(413);
    } finally {
      await close();
    }
  });

  it("verifies the webhook HMAC over the original bytes of a base64-encoded body", async () => {
    const { call, close } = await setup();
    const raw = Buffer.from(JSON.stringify({ zen: "Keep it logically awesome é ü 日本" }), "utf8");
    const sign = (bytes: Buffer, secret = SECRETS.GITHUB_WEBHOOK_SECRET) =>
      `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
    const deliver = (id: string, signature: string) =>
      call(
        event({
          method: "POST",
          path: "/webhooks/github",
          headers: { "x-github-event": "ping", "x-github-delivery": id, "x-hub-signature-256": signature },
          body: raw.toString("base64"),
          base64: true,
        }),
      );
    try {
      expect((await deliver("delivery-1", sign(raw))).statusCode).toBe(200);
      expect((await deliver("delivery-2", sign(raw, "wrong-secret"))).statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("does not cache a failed start: the next invocation tries again", async () => {
    const { db, close } = await createTestDb();
    let attempts = 0;
    const handler = createHandler({
      loadSecrets: async () => {
        attempts++;
        if (attempts === 1) throw new Error("SSM unavailable");
        return SECRETS;
      },
      buildApp: () => buildApp({ db, logger: false }),
    });
    try {
      await expect(handler(event({ method: "GET", path: "/health" }), context)).rejects.toThrow("SSM unavailable");
      const res = (await handler(event({ method: "GET", path: "/health" }), context)) as { statusCode: number };
      expect(res.statusCode).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await close();
    }
  });
});
