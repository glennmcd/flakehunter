import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { seedRepo } from "../../test/fixtures.js";
import { createTestDb } from "../../test/testDb.js";
import { repoApiTokens } from "../db/schema.js";
import { findRepoByToken, hashToken, mintRepoToken, revokeRepoToken } from "./repoToken.js";

describe("repo API tokens", () => {
  it("mints an fh_ token, stores only its hash, and resolves it back to the repo", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const { token, prefix } = await mintRepoToken(db, repo.id);

      expect(token.startsWith("fh_")).toBe(true);
      expect(token.length).toBeGreaterThan(40);
      expect(prefix).toBe(token.slice(0, 8));

      const [row] = await db.select().from(repoApiTokens);
      expect(row?.tokenHash).toBe(hashToken(token));
      expect(row?.tokenHash).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);

      expect(await findRepoByToken(db, token)).toEqual({ id: repo.id, fullName: "acme/widgets" });
    } finally {
      await close();
    }
  });

  it("mints a distinct token each time", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const a = await mintRepoToken(db, repo.id);
      const b = await mintRepoToken(db, repo.id);
      expect(a.token).not.toBe(b.token);
    } finally {
      await close();
    }
  });

  it("returns null for unknown, empty and revoked tokens", async () => {
    const { db, close } = await createTestDb();
    try {
      const repo = await seedRepo(db);
      const { token } = await mintRepoToken(db, repo.id);

      expect(await findRepoByToken(db, "fh_nope")).toBeNull();
      expect(await findRepoByToken(db, "")).toBeNull();

      await revokeRepoToken(db, token);
      expect(await findRepoByToken(db, token)).toBeNull();
      const [row] = await db
        .select()
        .from(repoApiTokens)
        .where(eq(repoApiTokens.tokenHash, hashToken(token)));
      expect(row?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await close();
    }
  });

  it("scopes each token to its own repo", async () => {
    const { db, close } = await createTestDb();
    try {
      const a = await seedRepo(db, { githubRepoId: 1, name: "a" });
      const b = await seedRepo(db, { githubRepoId: 2, name: "b" });
      const tokenA = await mintRepoToken(db, a.id);
      const tokenB = await mintRepoToken(db, b.id);
      expect((await findRepoByToken(db, tokenA.token))?.id).toBe(a.id);
      expect((await findRepoByToken(db, tokenB.token))?.id).toBe(b.id);
    } finally {
      await close();
    }
  });
});
