import { desc, eq, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { flakyTests } from "../db/schema.js";

export async function getFlakyTests(db: AnyDb, repoId: number) {
  return db.select().from(flakyTests).where(eq(flakyTests.repoId, repoId)).orderBy(desc(flakyTests.lastSeenAt));
}

/**
 * Rollup across all flaky SHAs per test: how many distinct commits it's been flaky on, and
 * when it was last seen flaky at all. Not currently wired to its own route (see /flaky-tests
 * ?summary=true), kept here since aggregating in SQL is much cheaper than in the client.
 */
export async function getFlakyTestsSummary(db: AnyDb, repoId: number) {
  return db
    .select({
      testCaseId: flakyTests.testCaseId,
      classname: flakyTests.classname,
      name: flakyTests.name,
      flakyShaCount: sql<number>`count(distinct ${flakyTests.headSha})`.mapWith(Number),
      lastSeenAt: sql<string>`max(${flakyTests.lastSeenAt})`,
    })
    .from(flakyTests)
    .where(eq(flakyTests.repoId, repoId))
    .groupBy(flakyTests.testCaseId, flakyTests.classname, flakyTests.name)
    .orderBy(desc(sql`max(${flakyTests.lastSeenAt})`));
}
