import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";

type Operation = {
  responses: Record<string, { headers?: Record<string, unknown> }>;
  security?: unknown[];
  parameters?: { name: string }[];
  deprecated?: boolean;
  description?: string;
};
type Spec = { openapi: string; info: { version: string }; paths: Record<string, Record<string, Operation>> };

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

async function getSpec(url = "/openapi.v2.json") {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json<Spec>();
}

describe("OpenAPI document", () => {
  it("is public (no token) and lists exactly the /api/v2 endpoints", async () => {
    const spec = await getSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe("2.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/api/v2/reports",
      "/api/v2/repos",
      "/api/v2/repos/{id}/summary",
      "/api/v2/tests/flaky",
      "/api/v2/tests/{id}/failures",
      "/api/v2/tests/{id}/history",
    ]);
  });

  it("has no $ref, so cutting a version out cannot leave a dangling reference", async () => {
    expect(JSON.stringify(await getSpec())).not.toContain("$ref");
  });

  it("describes the upload: token, XML body, gzip, idempotent 200/201 and the error responses", async () => {
    const post = (await getSpec()).paths["/api/v2/reports"]?.post;
    expect(post?.security).toEqual([{ uploadToken: [] }]);
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "413", "422", "429"]);
    expect(post?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(["x-fh-run-id", "x-fh-sha", "x-fh-report-key", "x-fh-ci-source", "content-encoding"]),
    );
    const body = (post as unknown as { requestBody: { content: Record<string, unknown> } }).requestBody;
    expect(Object.keys(body.content).sort()).toEqual(["application/xml", "text/xml"]);
  });

  it("marks no operation deprecated and no longer mentions v1", async () => {
    const spec = await getSpec();
    for (const op of Object.values(spec.paths).flatMap((ops) => Object.values(ops))) {
      expect(op.deprecated).toBeUndefined();
      expect(JSON.stringify(op.responses)).not.toContain("Deprecation");
    }
    expect(JSON.stringify(spec)).not.toMatch(/\bv1\b/);
  });

  it("documents the 401 for read endpoints", async () => {
    const get = (await getSpec()).paths["/api/v2/tests/flaky"]?.get;
    expect(Object.keys(get?.responses ?? {})).toEqual(expect.arrayContaining(["200", "400", "401", "404"]));
  });

  it("serves the docs page without a token, redirects /docs to it and keeps other routes gated", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs/v2" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/html");
    expect(docs.body).toContain("/openapi.v2.json");
    expect(docs.body).not.toContain("deprecated");
    const legacy = await app.inject({ method: "GET", url: "/docs" });
    expect(legacy.statusCode).toBe(302);
    expect(legacy.headers.location).toBe("/docs/v2");
    const gated = await app.inject({ method: "GET", url: "/api/v2/repos" });
    expect(gated.statusCode).toBe(401);
  });
});
