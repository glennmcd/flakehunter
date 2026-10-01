import type { ApiClient } from "./api";
import { type OverviewParams, PAGE_SIZE, sinceFor } from "./overview";

/** Everything the overview page shows, fetched in parallel. Rejects with the first ApiClientError. */
export async function loadOverview(
  client: Pick<ApiClient, "getRepoSummary" | "getFlakyTests">,
  repoId: number,
  params: OverviewParams,
  now: Date = new Date(),
) {
  const since = sinceFor(params.days, now);
  const [summary, flaky] = await Promise.all([
    client.getRepoSummary(repoId, { since }),
    client.getFlakyTests({
      repo: repoId,
      since,
      minRuns: params.minRuns,
      limit: PAGE_SIZE,
      offset: (params.page - 1) * PAGE_SIZE,
    }),
  ]);
  return { summary, flaky: { data: flaky.data, total: flaky.page.total } };
}
