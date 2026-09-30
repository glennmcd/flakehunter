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
