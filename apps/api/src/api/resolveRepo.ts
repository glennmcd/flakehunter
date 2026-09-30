import { eq } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { repos } from "../db/schema.js";
import { ApiError } from "./errors.js";

export type RepoRef = { id: number; fullName?: undefined } | { id?: undefined; fullName: string };

/** Resolves a `repo` query value (numeric id or owner/name) to a repo row, or throws a 404 ApiError. */
export async function resolveRepo(db: AnyDb, ref: RepoRef): Promise<{ id: number; fullName: string }> {
  const [repo] = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(ref.id !== undefined ? eq(repos.id, ref.id) : eq(repos.fullName, ref.fullName));
  if (!repo) {
    throw new ApiError("not_found", `Repo ${ref.id ?? ref.fullName} not found`);
  }
  return repo;
}
