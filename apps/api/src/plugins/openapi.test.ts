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

async function getSpec(url = "/openapi.json") {
  const res = await app.inject({ method: "GET", url });
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

  it("serves v2 as its own public document with exactly the /api/v2 endpoints", async () => {
    const v2 = await getSpec("/openapi.v2.json");
    expect(v2.openapi).toBe("3.1.0");
    expect(v2.info.version).toBe("2.0.0");
    expect(Object.keys(v2.paths).sort()).toEqual([
      "/api/v2/reports",
      "/api/v2/repos",
      "/api/v2/repos/{id}/summary",
      "/api/v2/tests/flaky",
      "/api/v2/tests/{id}/failures",
      "/api/v2/tests/{id}/history",
    ]);
    // Cutting out v2 must not change what v1 serves afterwards.
    const v1 = await getSpec();
    expect(v1.info.version).toBe("1.1.0");
    expect(Object.keys(v1.paths).some((path) => path.startsWith("/api/v2"))).toBe(false);
  });

  it("has no $ref in either document, so splitting them cannot leave a dangling reference", async () => {
    for (const url of ["/openapi.json", "/openapi.v2.json"]) {
      expect(JSON.stringify(await getSpec(url))).not.toContain("$ref");
    }
  });

  it.each([
    ["/openapi.json", "/api/reports"],
    ["/openapi.v2.json", "/api/v2/reports"],
  ])(
    "%s describes the upload: token, XML body, gzip, idempotent 200/201 and the error responses",
    async (url, path) => {
      const post = (await getSpec(url)).paths[path]?.post;
      expect(post?.security).toEqual([{ uploadToken: [] }]);
      expect(Object.keys(post?.responses ?? {}).sort()).toEqual(["200", "201", "400", "401", "413", "422", "429"]);
      expect(post?.parameters?.map((p) => p.name)).toEqual(
        expect.arrayContaining(["x-fh-run-id", "x-fh-sha", "x-fh-report-key", "content-encoding"]),
      );
      const body = (post as unknown as { requestBody: { content: Record<string, unknown> } }).requestBody;
      expect(Object.keys(body.content).sort()).toEqual(["application/xml", "text/xml"]);
    },
  );

  it("marks every v1 operation deprecated, pointing at v2, with the deprecation headers on every response", async () => {
    const operations = Object.values((await getSpec()).paths).flatMap((ops) => Object.values(ops));
    expect(operations).toHaveLength(6);
    for (const op of operations) {
      expect(op.deprecated).toBe(true);
      expect(op.description).toContain("use the same operation under /api/v2");
      for (const response of Object.values(op.responses)) {
        expect(Object.keys(response.headers ?? {})).toEqual(expect.arrayContaining(["Deprecation", "Link"]));
      }
    }
  });

  it("marks no v2 operation deprecated", async () => {
    const operations = Object.values((await getSpec("/openapi.v2.json")).paths).flatMap((ops) => Object.values(ops));
    for (const op of operations) {
      expect(op.deprecated).toBeUndefined();
      expect(JSON.stringify(op.responses)).not.toContain("Deprecation");
    }
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
    expect(docs.body).not.toContain("/openapi.v2.json");
    expect(docs.body).toContain('<a href="/docs/v2">');
    const docsV2 = await app.inject({ method: "GET", url: "/docs/v2" });
    expect(docsV2.statusCode).toBe(200);
    expect(docsV2.headers["content-type"]).toContain("text/html");
    expect(docsV2.body).toContain("/openapi.v2.json");
    expect(docsV2.body).not.toContain("deprecated");
    const gated = await app.inject({ method: "GET", url: "/api/repos" });
    expect(gated.statusCode).toBe(401);
  });
});
