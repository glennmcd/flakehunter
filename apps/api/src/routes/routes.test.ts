import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../../test/testDb.js";
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

  it("serves every endpoint the API had under autoload", async () => {
    const { db, close } = await createTestDb();
    const app = await buildApp({ db, logger: false });
    try {
      const expected: [string, string][] = [
        ["GET", "/health"],
        ["GET", "/repos"],
        ["GET", "/repos/:id/flaky-tests"],
        ["GET", "/repos/:id/runs"],
        ["GET", "/repos/:id/tests/:testCaseId/results"],
        ["GET", "/api/repos"],
        ["GET", "/api/repos/:id/summary"],
        ["GET", "/api/tests/flaky"],
        ["GET", "/api/tests/:id/history"],
        ["POST", "/api/reports"],
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
    } finally {
      await app.close();
      await close();
    }
  });
});
