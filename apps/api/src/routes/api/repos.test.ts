import { describe, expect, it } from "bun:test";
import { buildApiApp } from "../../../test/apiApp.js";
import { seedRepo } from "../../../test/fixtures.js";
import { createTestDb } from "../../../test/testDb.js";
import { API_VERSIONS, type ApiVersion, apiPrefix } from "../../api/version.js";
import reposRoute from "./repos.js";

async function setup(apiVersion: ApiVersion) {
  const { db, close } = await createTestDb();
  const app = await buildApiApp(db, [reposRoute], apiVersion);
  return { db, close, app };
}

describe.each([...API_VERSIONS])("GET /repos (v%d)", (apiVersion) => {
  const api = apiPrefix(apiVersion);

  it("lists repos ordered by full name with only the public fields", async () => {
    const { db, close, app } = await setup(apiVersion);
    try {
      await seedRepo(db, { externalRepoId: 1, owner: "zeta", name: "last" });
      await seedRepo(db, { externalRepoId: 2, owner: "acme", name: "widgets" });
      await seedRepo(db, { externalRepoId: 3, owner: "acme", name: "api" });

      const res = await app.inject({ method: "GET", url: `${api}/repos` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toEqual({ limit: 50, offset: 0, total: 3 });
      expect(body.data.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/api", "acme/widgets", "zeta/last"]);
      expect(body.data[0]).toEqual({
        id: expect.any(Number),
        fullName: "acme/api",
        owner: "acme",
        name: "api",
        ...(apiVersion === 2 && { host: "github" }),
      });
    } finally {
      await close();
    }
  });

  it("paginates with a total that ignores limit and offset", async () => {
    const { db, close, app } = await setup(apiVersion);
    try {
      for (const name of ["a", "b", "c"]) await seedRepo(db, { externalRepoId: name.charCodeAt(0), name });

      const page2 = await app.inject({ method: "GET", url: `${api}/repos?limit=2&offset=2` });
      expect(page2.json().page).toEqual({ limit: 2, offset: 2, total: 3 });
      expect(page2.json().data.map((r: { name: string }) => r.name)).toEqual(["c"]);

      const beyond = await app.inject({ method: "GET", url: `${api}/repos?limit=2&offset=20` });
      expect(beyond.json().data).toEqual([]);
      expect(beyond.json().page.total).toBe(3);
    } finally {
      await close();
    }
  });

  it("returns an empty page when no repos exist", async () => {
    const { close, app } = await setup(apiVersion);
    try {
      const res = await app.inject({ method: "GET", url: `${api}/repos` });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown>()).toEqual({ data: [], page: { limit: 50, offset: 0, total: 0 } });
    } finally {
      await close();
    }
  });

  it("returns 400 for invalid pagination", async () => {
    const { close, app } = await setup(apiVersion);
    try {
      for (const url of [`${api}/repos?limit=0`, `${api}/repos?limit=201`, `${api}/repos?offset=-1`]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
    } finally {
      await close();
    }
  });
});
