import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../../test/testDb.js";
import { API_VERSIONS } from "../api/version.js";
import { buildApp } from "../app.js";
import { routeModules } from "./index.js";

const routesDir = path.dirname(fileURLToPath(import.meta.url));

/** Route files on disk (relative path without extension), excluding tests and this registry. */
function routeFilesOnDisk(dir = routesDir, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return routeFilesOnDisk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) return [];
    const name = entry.name.replace(/\.ts$/, "");
    return prefix === "" && name === "index" ? [] : [`${prefix}${name}`];
  });
}

const saved = { ...process.env };
beforeAll(() => {
  process.env.API_TOKEN = "test-token";
  process.env.GITHUB_PAT = "test-pat";
  process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
});
afterAll(() => {
  process.env = saved;
});

describe("route registry", () => {
  it("lists every route file on disk exactly once, so none can be forgotten", () => {
    expect(routeModules.map((m) => m.file).sort()).toEqual(routeFilesOnDisk().sort());
  });

  it("mounts files under routes/api at /api and routes/webhooks at /webhooks, the rest at the root", () => {
    for (const m of routeModules) {
      const expected = m.file.startsWith("api/") ? "/api" : m.file.startsWith("webhooks/") ? "/webhooks" : "";
      expect(m.prefix).toBe(expected);
    }
  });

  it("registers files under routes/api for every API version, and nothing else", () => {
    for (const m of routeModules) {
      expect(m.versions).toEqual(m.file.startsWith("api/") ? API_VERSIONS : undefined);
    }
  });

  it("serves health, the webhook and each published route under /api/v2", async () => {
    const { db, close } = await createTestDb();
    const app = await buildApp({ db, logger: false });
    try {
      const expected: [string, string][] = [
        ["GET", "/health"],
        ["GET", "/api/v2/repos"],
        ["GET", "/api/v2/repos/:id/summary"],
        ["GET", "/api/v2/tests/flaky"],
        ["GET", "/api/v2/tests/:id/history"],
        ["GET", "/api/v2/tests/:id/failures"],
        ["POST", "/api/v2/reports"],
        ["POST", "/webhooks/github"],
      ];
      for (const [method, url] of expected) {
        expect(app.hasRoute({ method: method as "GET" | "POST", url })).toBe(true);
      }
    } finally {
      await app.close();
      await close();
    }
  });

  it("does not expose a route at an unprefixed path it should not have", async () => {
    const { db, close } = await createTestDb();
    const app = await buildApp({ db, logger: false });
    try {
      // The webhook plugin registers "/github"; only the /webhooks-prefixed path may exist.
      expect(app.hasRoute({ method: "POST", url: "/github" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/reports" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/tests/flaky" })).toBe(false);
      // API v1 (/api) and the week-1 root routes were removed.
      for (const url of ["/api/repos", "/api/tests/flaky", "/repos", "/repos/:id/flaky-tests", "/repos/:id/runs"]) {
        expect(app.hasRoute({ method: "GET", url })).toBe(false);
      }
      expect(app.hasRoute({ method: "GET", url: "/repos/:id/tests/:testCaseId/results" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/api/reports" })).toBe(false);
      // Only published API routes get a v2 mount.
      expect(app.hasRoute({ method: "POST", url: "/api/v2/webhooks/github" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/api/v2/health" })).toBe(false);
    } finally {
      await app.close();
      await close();
    }
  });
});
