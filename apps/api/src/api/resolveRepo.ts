import type { RepoHost } from "@flakehunter/shared-types";
import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { repos } from "../db/schema.js";
import { ApiError } from "./errors.js";

export type RepoRef =
  | { id: number; fullName?: undefined; host?: undefined }
  | { id?: undefined; fullName: string; host?: RepoHost };

/**
 * Resolves a `repo` query value (numeric id, or a path, optionally within one host) to a repo row. Throws a 404
 * ApiError when nothing matches, and a 400 naming the hosts when a path without a host matches repositories on more
 * than one.
 */
export async function resolveRepo(db: AnyDb, ref: RepoRef): Promise<{ id: number; fullName: string }> {
  const where =
    ref.id !== undefined
      ? eq(repos.id, ref.id)
      : and(eq(repos.fullName, ref.fullName), ref.host ? eq(repos.host, ref.host) : undefined);
  // (host, full_name) is unique, so there is at most one match per host.
  const matches = await db
    .select({ id: repos.id, host: repos.host, fullName: repos.fullName })
    .from(repos)
    .where(where);

  const [repo] = matches;
  if (!repo) {
    const name = ref.id ?? (ref.host ? `${ref.host}:${ref.fullName}` : ref.fullName);
    throw new ApiError("not_found", `Repo ${name} not found`);
  }
  if (matches.length > 1) {
    const hosts = matches.map((m) => m.host).sort();
    throw new ApiError(
      "validation_error",
      `Repo ${ref.fullName} is registered on more than one host: ${hosts.join(", ")}`,
      [{ path: "query.repo", message: `matches repositories on hosts ${hosts.join(", ")}` }],
    );
  }
  return { id: repo.id, fullName: repo.fullName };
}
