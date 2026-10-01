import { type ApiClient, ApiClientError } from "./api";
import { CHART_LIMIT, type HistoryParams, PAGE_SIZE } from "./history";
import { sinceFor } from "./overview";

/**
 * Everything the detail page shows: the newest results in the window for the timeline (all statuses) and one filtered
 * page for the table, fetched in parallel. A test that belongs to another repo than the URL's is a not_found, so a
 * mismatched link cannot show a test under the wrong repo.
 */
export async function loadHistory(
  client: Pick<ApiClient, "getTestHistory">,
  repoId: number,
  testId: number,
  params: HistoryParams,
  now: Date = new Date(),
) {
  const since = sinceFor(params.days, now);
  const [chart, table] = await Promise.all([
    client.getTestHistory(testId, { since, limit: CHART_LIMIT, offset: 0 }),
    client.getTestHistory(testId, {
      since,
      status: params.status,
      limit: PAGE_SIZE,
      offset: (params.page - 1) * PAGE_SIZE,
    }),
  ]);
  if (chart.test.repoId !== repoId) throw new ApiClientError("not_found", "Test not found in this repository", 404);
  return {
    test: chart.test,
    chart: { items: chart.data, total: chart.page.total },
    table: { items: table.data, total: table.page.total },
  };
}
