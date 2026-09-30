import { describe, expect, it } from "bun:test";
import { createTestDb } from "./testDb.js";
import { repos } from "../src/db/schema.js";

describe("testDb", () => {
  it("applies migrations and allows basic inserts", async () => {
    const { db, close } = await createTestDb();
    try {
      await db.insert(repos).values({
        githubRepoId: 1,
        owner: "glennmcd",
        name: "FlakeHunter",
        fullName: "glennmcd/FlakeHunter",
      });
      const rows = await db.select().from(repos);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.fullName).toBe("glennmcd/FlakeHunter");
    } finally {
      await close();
    }
  });
});
