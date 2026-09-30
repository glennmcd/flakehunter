import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { repoApiTokens, repos } from "../db/schema.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a per-repo upload token. The plaintext is returned once; only its sha256 is stored. */
export async function mintRepoToken(db: AnyDb, repoId: number): Promise<{ token: string; prefix: string }> {
  const token = `fh_${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, 8);
  await db.insert(repoApiTokens).values({ repoId, tokenHash: hashToken(token), prefix });
  return { token, prefix };
}

export async function revokeRepoToken(db: AnyDb, token: string): Promise<void> {
  await db.update(repoApiTokens).set({ revokedAt: new Date() }).where(eq(repoApiTokens.tokenHash, hashToken(token)));
}

export async function findRepoByToken(db: AnyDb, token: string): Promise<{ id: number; fullName: string } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repoApiTokens)
    .innerJoin(repos, eq(repos.id, repoApiTokens.repoId))
    .where(and(eq(repoApiTokens.tokenHash, hashToken(token)), isNull(repoApiTokens.revokedAt)));
  return row ?? null;
}
