import type { FlakyTestItem, RepoSummaryResponse } from "@flakehunter/shared-types";
import Link from "next/link";
import {
  formatPercent,
  formatRelativeTime,
  type OverviewParams,
  overviewHref,
  pageCount,
  pageRange,
  WINDOW_OPTIONS,
} from "../lib/overview";

export function SummaryStats({ summary, now }: { summary: RepoSummaryResponse; now?: Date }) {
  const { totals } = summary;
  const stats: { label: string; value: string; title?: string; flaky?: boolean }[] = [
    { label: "Runs", value: totals.runs.toLocaleString("en-US") },
    { label: "Tests", value: totals.tests.toLocaleString("en-US") },
    { label: "Pass rate", value: formatPercent(totals.passRate), title: "passed / (passed + failed)" },
    { label: "Flaky tests", value: totals.flakyTests.toLocaleString("en-US"), flaky: totals.flakyTests > 0 },
    { label: "Flaky commits", value: totals.flakyShas.toLocaleString("en-US"), flaky: totals.flakyShas > 0 },
    {
      label: "Last run",
      value: formatRelativeTime(summary.lastRunAt, now),
      title: "Latest run, even outside this window",
    },
  ];
  return (
    <dl className="stats" aria-label="Repository summary">
      {stats.map((stat) => (
        <div className={stat.flaky ? "stat stat-flaky" : "stat"} key={stat.label} title={stat.title}>
          <dt>{stat.label}</dt>
          <dd>{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function WindowSelector({ repoId, params }: { repoId: number; params: OverviewParams }) {
  return (
    <nav className="segmented" aria-label="Time window">
      {WINDOW_OPTIONS.map((days) => (
        <Link
          key={days}
          href={overviewHref(repoId, params, { days, page: 1 })}
          aria-current={days === params.days ? "page" : undefined}
        >
          {days} days
        </Link>
      ))}
    </nav>
  );
}

/** A plain GET form, so it works without client JavaScript; the window is carried in a hidden field. */
export function MinRunsForm({ repoId, params }: { repoId: number; params: OverviewParams }) {
  return (
    <form method="get" action={`/repos/${repoId}`} className="filter">
      <input type="hidden" name="days" value={params.days} />
      <label htmlFor="minRuns">Minimum commits run</label>
      <input id="minRuns" name="minRuns" type="number" min={1} max={1000} defaultValue={params.minRuns} />
      <button type="submit">Apply</button>
    </form>
  );
}

export function FlakeRateBar({ rate }: { rate: number }) {
  const width = Math.max(0, Math.min(100, rate * 100));
  return (
    <span className="bar" aria-hidden="true">
      <span className="bar-fill" style={{ width: `${width}%` }} />
    </span>
  );
}

export function FlakyTable({ repoId, rows, now }: { repoId: number; rows: FlakyTestItem[]; now?: Date }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard focusable
    <section className="table-scroll" aria-label="Flakiest tests" tabIndex={0}>
      <table className="data">
        <caption className="visually-hidden">Flakiest tests, highest flake rate first</caption>
        <thead>
          <tr>
            <th scope="col">Test</th>
            <th scope="col">Flake rate</th>
            <th scope="col" className="num">
              Flaky / run
            </th>
            <th scope="col">Last flaky</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.testId}>
              <th scope="row">
                <Link className="row-link" href={`/repos/${repoId}/tests/${row.testId}`}>
                  <span className="test-name">{row.name}</span>
                  <span className="test-class">{row.classname}</span>
                </Link>
              </th>
              <td className="rate-cell">
                <FlakeRateBar rate={row.flakeRate} />
                <span className="rate">{formatPercent(row.flakeRate)}</span>
              </td>
              <td className="num">
                {row.flakyShas} / {row.shasRun}
              </td>
              <td>
                <time dateTime={row.lastFlakyAt}>{formatRelativeTime(row.lastFlakyAt, now)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Pagination({ repoId, params, total }: { repoId: number; params: OverviewParams; total: number }) {
  const pages = pageCount(total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>{pageRange(params.page, total)}</span>
      {params.page > 1 ? (
        <Link href={overviewHref(repoId, params, { page: params.page - 1 })} rel="prev">
          Previous
        </Link>
      ) : null}
      {params.page < pages ? (
        <Link href={overviewHref(repoId, params, { page: params.page + 1 })} rel="next">
          Next
        </Link>
      ) : null}
    </nav>
  );
}

export function EmptyFlakyTests({ params }: { params: OverviewParams }) {
  return (
    <p className="empty">
      No flaky tests in the last {params.days} days among tests that ran on at least {params.minRuns} commits.
      {params.minRuns > 1 ? " Lowering the minimum may surface more." : ""}
    </p>
  );
}

export interface OverviewProps {
  repoId: number;
  params: OverviewParams;
  summary: RepoSummaryResponse;
  flaky: { data: FlakyTestItem[]; total: number };
  now?: Date;
}

export function Overview({ repoId, params, summary, flaky, now }: OverviewProps) {
  return (
    <main>
      <header className="page-header">
        <p className="breadcrumb">
          <Link href="/?list=1">Repositories</Link>
        </p>
        <h1>{summary.repo.fullName}</h1>
        <WindowSelector repoId={repoId} params={params} />
      </header>
      <SummaryStats summary={summary} now={now} />
      <section aria-labelledby="flaky-heading">
        <div className="section-head">
          <h2 id="flaky-heading">Flakiest tests</h2>
          <MinRunsForm repoId={repoId} params={params} />
        </div>
        {flaky.data.length === 0 ? (
          <EmptyFlakyTests params={params} />
        ) : (
          <>
            <FlakyTable repoId={repoId} rows={flaky.data} now={now} />
            <Pagination repoId={repoId} params={params} total={flaky.total} />
          </>
        )}
      </section>
    </main>
  );
}

export function ErrorState({ title, message, requestId }: { title: string; message: string; requestId?: string }) {
  return (
    <main>
      <div className="error" role="alert">
        <h1>{title}</h1>
        <p>{message}</p>
        {requestId ? <p className="hint">Request id: {requestId}</p> : null}
      </div>
    </main>
  );
}
