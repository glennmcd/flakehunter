import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";

type Operation = { responses: Record<string, unknown>; security?: unknown[]; parameters?: { name: string }[] };
type Spec = { openapi: string; paths: Record<string, Record<string, Operation>> };

const saved = { ...process.env };
let app: Awaited<ReturnType<typeof buildApp>>;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.API_TOKEN = "test-token";
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
  const testDb = await createTestDb();
  app = await buildApp({ db: testDb.db, logger: false });
  close = async () => {
    await app.close();
    await testDb.close();
  };
});
afterAll(async () => {
  await close();
  process.env = saved;
});

async function getSpec() {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  expect(res.statusCode).toBe(200);
  return res.json<Spec>();
}

describe("OpenAPI document", () => {
  it("is public (no token) and lists exactly the v1 endpoints", async () => {
    const spec = await getSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/api/reports",
      "/api/repos",
      "/api/repos/{id}/summary",
      "/api/tests/flaky",
      "/api/tests/{id}/failures",
      "/api/tests/{id}/history",
    ]);
  });

  it("describes the upload: token, XML body, gzip, idempotent 200/201 and the error responses", async () => {
    const post = (await getSpec()).paths["/api/reports"]?.post;
    expect(post?.security).toEqual([{ uploadToken: [] }]);
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "413", "422", "429"]);
    expect(post?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(["x-fh-run-id", "x-fh-sha", "x-fh-report-key", "content-encoding"]),
    );
    const body = (post as unknown as { requestBody: { content: Record<string, unknown> } }).requestBody;
    expect(Object.keys(body.content).sort()).toEqual(["application/xml", "text/xml"]);
  });

  it("documents the 401 for read endpoints", async () => {
    const get = (await getSpec()).paths["/api/tests/flaky"]?.get;
    expect(Object.keys(get?.responses ?? {})).toEqual(expect.arrayContaining(["200", "400", "401", "404"]));
  });

  it("serves the docs page without a token and keeps other routes gated", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/html");
    expect(docs.body).toContain("/openapi.json");
    const gated = await app.inject({ method: "GET", url: "/api/repos" });
    expect(gated.statusCode).toBe(401);
  });
});
