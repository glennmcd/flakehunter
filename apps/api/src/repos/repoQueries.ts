import type { ReposResponse } from "@flakehunter/shared-types";
import { asc, sql } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { repos } from "../db/schema.js";

/** Registered repos ordered by full name (id as tiebreak), plus the total for pagination. */
export async function listRepos(
  db: AnyDb,
  { limit, offset }: { limit: number; offset: number },
): Promise<ReposResponse> {
  const data = await db
    .select({ id: repos.id, fullName: repos.fullName, owner: repos.owner, name: repos.name })
    .from(repos)
    .orderBy(asc(repos.fullName), asc(repos.id))
    .limit(limit)
    .offset(offset);

  const [totalRow] = await db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(repos);

  return { data, page: { limit, offset, total: totalRow?.total ?? 0 } };
}
