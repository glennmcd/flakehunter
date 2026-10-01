import type { RepoItem } from "@flakehunter/shared-types";
import type { ApiClient } from "./api";
import { describeError, type ErrorView } from "./errors";

/** How many repositories the home page lists; the API's own maximum page is 200. */
export const REPO_LIST_LIMIT = 100;

export type HomeResult =
  | { kind: "redirect"; repoId: number }
  | { kind: "list"; repos: RepoItem[]; total: number }
  | { kind: "error"; error: ErrorView };

/**
 * What the home page should do. With exactly one repository it redirects straight to that repo's overview, unless
 * `showAll` is set (the "Repositories" breadcrumb passes `?list=1`, otherwise it would bounce straight back). Errors
 * become a view instead of throwing, so the page can call redirect() outside a try block (redirect works by throwing).
 */
export async function decideHome(client: Pick<ApiClient, "listRepos">, showAll: boolean): Promise<HomeResult> {
  try {
    const { data, page } = await client.listRepos({ limit: REPO_LIST_LIMIT });
    const only = data[0];
    if (!showAll && page.total === 1 && only) return { kind: "redirect", repoId: only.id };
    return { kind: "list", repos: data, total: page.total };
  } catch (error) {
    return { kind: "error", error: describeError(error) };
  }
}
