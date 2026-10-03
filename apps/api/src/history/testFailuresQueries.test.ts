import { describe, expect, it } from "bun:test";
import { daysAgo, seedRepo, seedResult, sha } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { FAILURE_LIMIT, getTestFailures } from "./testFailuresQueries.js";

describe("getTestFailures", () => {
  it("returns null for an unknown test", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await getTestFailures(db, 123)).toBeNull();
    } finally {
      await close();
    }
  });

  it("keeps failed and error results, drops passed and skipped, newest first", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const { testCase } = await seedResult(db, repo.id, { status: "failed", headSha: sha(1), createdAt: daysAgo(4) });
      await seedResult(db, repo.id, { status: "passed", headSha: sha(2), createdAt: daysAgo(3) });
      await seedResult(db, repo.id, { status: "skipped", headSha: sha(3), createdAt: daysAgo(2) });
      await seedResult(db, repo.id, { status: "error", headSha: sha(4), createdAt: daysAgo(1) });

      const result = await getTestFailures(db, testCase.id);

      expect(result?.data.map((d) => d.status)).toEqual(["error", "failed"]);
    } finally {
      await close();
    }
  });

  it("caps the list at FAILURE_LIMIT", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      let testId = 0;
      for (let i = 0; i < FAILURE_LIMIT + 3; i++) {
        const seeded = await seedResult(db, repo.id, {
          status: "failed",
          headSha: sha(i),
          createdAt: daysAgo(100 - i),
        });
        testId = seeded.testCase.id;
      }
      expect((await getTestFailures(db, testId))?.data).toHaveLength(FAILURE_LIMIT);
    } finally {
      await close();
    }
  });
});
