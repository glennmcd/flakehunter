import { describe, expect, it } from "bun:test";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { ApiError } from "./errors.js";
import { resolveRepo } from "./resolveRepo.js";

describe("resolveRepo", () => {
  it("finds a repo by numeric id or by full name", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      expect(await resolveRepo(db, { id: repo.id })).toEqual({ id: repo.id, fullName: "acme/widgets" });
      expect(await resolveRepo(db, { fullName: "acme/widgets" })).toEqual({ id: repo.id, fullName: "acme/widgets" });
    } finally {
      await close();
    }
  });

  it("finds a repo whose full name has more than two segments", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db, { owner: "group/sub", name: "project" });
      expect(await resolveRepo(db, { fullName: "group/sub/project" })).toEqual({
        id: repo.id,
        fullName: "group/sub/project",
      });
    } finally {
      await close();
    }
  });

  it("throws a not_found ApiError for an unknown repo", async () => {
    const { db, close } = await createTestDb();
    try {
      for (const ref of [{ id: 42 }, { fullName: "nobody/nothing" }]) {
        const err = await resolveRepo(db, ref).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe("not_found");
      }
    } finally {
      await close();
    }
  });
});

describe("resolveRepo with more than one host", () => {
  async function twoHosts() {
    const { db, close } = await createTestDb();
    const github = await seedRepo(db);
    const gitlab = await seedRepo(db, { host: "gitlab", externalRepoId: 2 });
    return { db, close, githubId: github.id, gitlabId: gitlab.id };
  }

  it("refuses to pick between two hosts for a bare path", async () => {
    const t = await twoHosts();
    try {
      const err = await resolveRepo(t.db, { fullName: "acme/widgets" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as ApiError).details).toEqual([
        { path: "query.repo", message: "matches repositories on hosts github, gitlab" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("finds the one repository when the host is named", async () => {
    const t = await twoHosts();
    try {
      expect(await resolveRepo(t.db, { fullName: "acme/widgets", host: "github" })).toEqual({
        id: t.githubId,
        fullName: "acme/widgets",
      });
      expect(await resolveRepo(t.db, { id: t.gitlabId })).toEqual({ id: t.gitlabId, fullName: "acme/widgets" });
    } finally {
      await t.close();
    }
  });
});
