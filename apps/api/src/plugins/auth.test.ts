import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import authPlugin from "./auth.js";
import errorHandlerPlugin from "./errorHandler.js";

const TOKEN = "test-global-token";
const savedToken = process.env.API_TOKEN;

beforeAll(() => {
  process.env.API_TOKEN = TOKEN;
});
afterAll(() => {
  if (savedToken === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = savedToken;
});

async function buildApp() {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  app.get("/health", async () => ({ ok: true }));
  app.get("/protected", async () => ({ ok: true }));
  for (const path of ["/api/reports", "/api/v2/reports"]) app.post(path, async () => ({ ok: true }));
  for (const path of ["/openapi.json", "/openapi.v2.json", "/docs", "/docs/v2", "/api/repos", "/api/v2/repos"]) {
    app.get(path, async () => ({ ok: true }));
  }
  app.post("/webhooks/github", async () => ({ ok: true }));
  return app;
}

describe("global auth hook", () => {
  it("rejects a missing or wrong bearer token with the standard 401 body", async () => {
    const app = await buildApp();
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
      const res = await app.inject({ method: "GET", url: "/protected", headers });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("unauthorized");
      expect(body.requestId).toBeTruthy();
    }
  });

  it("accepts the correct bearer token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it("exempts /health, /webhooks/github and /api/reports (which does its own per-repo auth)", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/webhooks/github" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/reports?x=1" })).statusCode).toBe(200);
  });

  it("exempts the upload route, the spec and the docs page of both API versions, and nothing else under them", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/api/v2/reports?x=1" })).statusCode).toBe(200);
    for (const url of ["/openapi.json", "/openapi.v2.json", "/docs", "/docs/v2"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
    for (const url of ["/api/repos", "/api/v2/repos"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("does not exempt lookalike paths", async () => {
    const app = await buildApp();
    for (const url of ["/api/reports/extra", "/api/v2/reports/extra", "/docs/v3"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });
});
