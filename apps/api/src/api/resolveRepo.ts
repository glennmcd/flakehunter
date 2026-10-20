import type { RepoHost } from "@flakehunter/shared-types";
import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { repos } from "../db/schema.js";
import { ApiError } from "./errors.js";

export type RepoRef =
  | { id: number; fullName?: undefined; host?: undefined }
  | { id?: undefined; fullName: string; host?: RepoHost };

/**
 * Resolves a `repo` query value (numeric id, or owner/name, optionally within one host) to a repo row. Throws a 404
 * ApiError when nothing matches, and a 400 when a path without a host matches repositories on more than one host.
 */
export async function resolveRepo(db: AnyDb, ref: RepoRef): Promise<{ id: number; fullName: string }> {
  const where =
    ref.id !== undefined
      ? eq(repos.id, ref.id)
      : and(eq(repos.fullName, ref.fullName), ref.host ? eq(repos.host, ref.host) : undefined);
  // Two rows are enough to tell a unique match from an ambiguous one.
  const matches = await db.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(where).limit(2);

  const [repo] = matches;
  if (!repo) {
    throw new ApiError("not_found", `Repo ${ref.id ?? ref.fullName} not found`);
  }
  if (matches.length > 1) {
    throw new ApiError("validation_error", `Repo ${ref.fullName} is registered on more than one host`, [
      { path: "query.repo", message: "matches repositories on more than one host" },
    ]);
  }
  return repo;
}
