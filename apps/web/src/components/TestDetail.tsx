import Link from "next/link";
import {
  flakyShas,
  formatDateTime,
  formatDuration,
  type HistoryItem,
  type HistoryParams,
  historyHref,
  PAGE_SIZE,
  STATUSES,
  safeHttpUrl,
  shortSha,
  type TestStatus,
} from "../lib/history";
import { formatRelativeTime, pageCount, pageRange, WINDOW_OPTIONS } from "../lib/overview";
import { HistoryChart, Marker } from "./HistoryChart";

const LABELS: Record<TestStatus, string> = { passed: "Passed", failed: "Failed", error: "Error", skipped: "Skipped" };

export function StatusBadge({ status }: { status: TestStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <svg width="14" height="14" viewBox="-8 -8 16 16" aria-hidden="true">
        <Marker status={status} x={0} y={0} />
      </svg>
      {LABELS[status]}
    </span>
  );
}

export function HistoryWindowSelector({
  repoId,
  testId,
  params,
}: {
  repoId: number;
  testId: number;
  params: HistoryParams;
}) {
  return (
    <nav className="segmented" aria-label="Time window">
      {WINDOW_OPTIONS.map((days) => (
        <Link
          key={days}
          href={historyHref(repoId, testId, params, { days, page: 1 })}
          aria-current={days === params.days ? "page" : undefined}
        >
          {days} days
        </Link>
      ))}
    </nav>
  );
}

/** A plain GET form, so it works without client JavaScript; the window is carried in a hidden field. */
export function StatusFilter({ repoId, testId, params }: { repoId: number; testId: number; params: HistoryParams }) {
  return (
    <form method="get" action={`/repos/${repoId}/tests/${testId}`} className="filter">
      <input type="hidden" name="days" value={params.days} />
      <label htmlFor="status">Status</label>
      <select id="status" name="status" defaultValue={params.status ?? ""}>
        <option value="">All</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {LABELS[status]}
          </option>
        ))}
      </select>
      <button type="submit">Apply</button>
    </form>
  );
}

export function HistoryTable({
  items,
  flaky,
  now,
}: {
  items: HistoryItem[];
  /** Commits known to be flaky (a pass and a fail); their rows are tagged. */
  flaky: ReadonlySet<string>;
  now?: Date;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard focusable
    <section className="table-scroll" aria-label="Results" tabIndex={0}>
      <table className="data data-wide">
        <caption className="visually-hidden">Results for this test, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Commit</th>
            <th scope="col">Run</th>
            <th scope="col">When</th>
            <th scope="col" className="num">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const url = safeHttpUrl(item.run.htmlUrl);
            const runLabel = `${item.run.workflowName} #${item.run.githubRunId}, attempt ${item.run.attempt}`;
            return (
              <tr key={item.resultId}>
                <td>
                  <StatusBadge status={item.status} />
                  {item.failureMessage ? (
                    <details className="failure">
                      <summary>Failure message</summary>
                      <pre>{item.failureMessage}</pre>
                    </details>
                  ) : null}
                </td>
                <td>
                  <code title={item.headSha}>{shortSha(item.headSha)}</code>
                  {flaky.has(item.headSha) ? <span className="tag">flaky commit</span> : null}
                  {item.headBranch ? <span className="test-class">{item.headBranch}</span> : null}
                </td>
                <td>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {runLabel}
                    </a>
                  ) : (
                    runLabel
                  )}
                </td>
                <td>
                  <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
                    {formatRelativeTime(item.createdAt, now)}
                  </time>
                </td>
                <td className="num">{formatDuration(item.durationSeconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function HistoryPagination({
  repoId,
  testId,
  params,
  total,
}: {
  repoId: number;
  testId: number;
  params: HistoryParams;
  total: number;
}) {
  const pages = pageCount(total, PAGE_SIZE);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>{pageRange(params.page, total, PAGE_SIZE)}</span>
      {params.page > 1 ? (
        <Link href={historyHref(repoId, testId, params, { page: params.page - 1 })} rel="prev">
          Previous
        </Link>
      ) : null}
      {params.page < pages ? (
        <Link href={historyHref(repoId, testId, params, { page: params.page + 1 })} rel="next">
          Next
        </Link>
      ) : null}
    </nav>
  );
}

export interface TestDetailProps {
  repoId: number;
  test: { id: number; classname: string; name: string };
  params: HistoryParams;
  chart: { items: HistoryItem[]; total: number };
  table: { items: HistoryItem[]; total: number };
  now?: Date;
}

export function TestDetail({ repoId, test, params, chart, table, now }: TestDetailProps) {
  const flakyCommits = flakyShas(chart.items);

  return (
    <main>
      <header className="page-header">
        <p className="breadcrumb">
          <Link href="/?list=1">Repositories</Link> / <Link href={`/repos/${repoId}`}>Repository overview</Link>
        </p>
        <h1>{test.name}</h1>
        <p className="test-class">{test.classname}</p>
        <HistoryWindowSelector repoId={repoId} testId={test.id} params={params} />
      </header>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        {chart.items.length === 0 ? (
          <p className="empty">No results for this test in the last {params.days} days.</p>
        ) : (
          <HistoryChart items={chart.items} total={chart.total} />
        )}
      </section>

      <section aria-labelledby="results-heading">
        <div className="section-head">
          <h2 id="results-heading">Results</h2>
          <StatusFilter repoId={repoId} testId={test.id} params={params} />
        </div>
        {table.items.length === 0 ? (
          <p className="empty">
            No {params.status ?? ""} results in the last {params.days} days.
          </p>
        ) : (
          <>
            <HistoryTable items={table.items} flaky={flakyCommits} now={now} />
            <HistoryPagination repoId={repoId} testId={test.id} params={params} total={table.total} />
          </>
        )}
      </section>
    </main>
  );
}
