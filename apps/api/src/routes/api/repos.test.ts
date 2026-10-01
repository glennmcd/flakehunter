import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { seedRepo } from "../../../test/fixtures.js";
import { createTestDb } from "../../../test/testDb.js";
import reposRoute from "./repos.js";

async function setup() {
  const { db, close } = await createTestDb();
  const app = await buildApiApp(db, [reposRoute]);
  return { db, close, app };
}

describe("GET /api/repos", () => {
  it("lists repos ordered by full name with only the public fields", async () => {
    const { db, close, app } = await setup();
    try {
      await seedRepo(db, { githubRepoId: 1, owner: "zeta", name: "last" });
      await seedRepo(db, { githubRepoId: 2, owner: "acme", name: "widgets" });
      await seedRepo(db, { githubRepoId: 3, owner: "acme", name: "api" });

      const res = await app.inject({ method: "GET", url: "/api/repos" });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toEqual({ limit: 50, offset: 0, total: 3 });
      expect(body.data.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/api", "acme/widgets", "zeta/last"]);
      expect(body.data[0]).toEqual({ id: expect.any(Number), fullName: "acme/api", owner: "acme", name: "api" });
    } finally {
      await close();
    }
  });

  it("paginates with a total that ignores limit and offset", async () => {
    const { db, close, app } = await setup();
    try {
      for (const name of ["a", "b", "c"]) await seedRepo(db, { githubRepoId: name.charCodeAt(0), name });

      const page2 = await app.inject({ method: "GET", url: "/api/repos?limit=2&offset=2" });
      expect(page2.json().page).toEqual({ limit: 2, offset: 2, total: 3 });
      expect(page2.json().data.map((r: { name: string }) => r.name)).toEqual(["c"]);

      const beyond = await app.inject({ method: "GET", url: "/api/repos?limit=2&offset=20" });
      expect(beyond.json().data).toEqual([]);
      expect(beyond.json().page.total).toBe(3);
    } finally {
      await close();
    }
  });

  it("returns an empty page when no repos exist", async () => {
    const { close, app } = await setup();
    try {
      const res = await app.inject({ method: "GET", url: "/api/repos" });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown>()).toEqual({ data: [], page: { limit: 50, offset: 0, total: 0 } });
    } finally {
      await close();
    }
  });

  it("returns 400 for invalid pagination", async () => {
    const { close, app } = await setup();
    try {
      for (const url of ["/api/repos?limit=0", "/api/repos?limit=201", "/api/repos?offset=-1"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });
});
