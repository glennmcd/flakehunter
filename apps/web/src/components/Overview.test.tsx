import { describe, expect, it } from "bun:test";
import type { FlakyTestItem, RepoSummaryResponse } from "@flakehunter/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PARAMS } from "../lib/overview";
import { EmptyFlakyTests, ErrorState, FlakeRateBar, FlakyTable, Overview, Pagination, SummaryCards } from "./Overview";

const now = new Date("2026-03-31T12:00:00.000Z");

const summary: RepoSummaryResponse = {
  repo: { id: 3, fullName: "flakehunter-demo/storefront" },
  window: { since: "2026-03-01T12:00:00.000Z" },
  totals: { runs: 89, tests: 47, results: 4000, passRate: 0.9731, flakyTests: 6, flakyShas: 31 },
  lastRunAt: "2026-03-31T09:00:00.000Z",
};

const row = (over: Partial<FlakyTestItem> = {}): FlakyTestItem => ({
  testId: 63,
  classname: "com.shop.PaymentGatewayIT",
  name: "retriesOnTimeout",
  shasRun: 58,
  flakyShas: 22,
  flakeRate: 22 / 58,
  lastFlakyAt: "2026-03-30T12:00:00.000Z",
  ...over,
});

describe("SummaryCards", () => {
  const html = renderToStaticMarkup(<SummaryCards summary={summary} now={now} />);

  it("shows every total with a label", () => {
    for (const text of ["Runs", "89", "Tests", "47", "Pass rate", "97.3%", "Flaky tests", "Flaky commits", "31"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("3 hours ago");
  });

  it("shows a dash when there is no pass rate or last run", () => {
    const empty = renderToStaticMarkup(
      <SummaryCards
        summary={{ ...summary, lastRunAt: null, totals: { ...summary.totals, passRate: null } }}
        now={now}
      />,
    );
    expect(empty).not.toContain("NaN");
    expect(empty).toContain("–");
  });
});

describe("FlakyTable", () => {
  it("links each test to its detail page and shows rate and counts", () => {
    const html = renderToStaticMarkup(<FlakyTable repoId={3} rows={[row()]} now={now} />);
    expect(html).toContain('href="/repos/3/tests/63"');
    expect(html).toContain("retriesOnTimeout");
    expect(html).toContain("com.shop.PaymentGatewayIT");
    expect(html).toContain("37.9%");
    expect(html).toContain("22 / 58");
    expect(html).toContain("1 day ago");
  });

  it("escapes test names", () => {
    const html = renderToStaticMarkup(<FlakyTable repoId={3} rows={[row({ name: "<script>alert(1)</script>" })]} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("FlakeRateBar", () => {
  it("fills in proportion to the rate and clamps out-of-range values", () => {
    expect(renderToStaticMarkup(<FlakeRateBar rate={0.25} />)).toContain("width:25%");
    expect(renderToStaticMarkup(<FlakeRateBar rate={1.7} />)).toContain("width:100%");
    expect(renderToStaticMarkup(<FlakeRateBar rate={-1} />)).toContain("width:0%");
  });
});

describe("Pagination", () => {
  it("offers only Next on the first page", () => {
    const html = renderToStaticMarkup(<Pagination repoId={3} params={DEFAULT_PARAMS} total={45} />);
    expect(html).toContain("1-20 of 45");
    expect(html).toContain('href="/repos/3?page=2"');
    expect(html).not.toContain("Previous");
  });

  it("offers both in the middle and keeps the other filters", () => {
    const html = renderToStaticMarkup(<Pagination repoId={3} params={{ days: 7, minRuns: 2, page: 2 }} total={45} />);
    expect(html).toContain('href="/repos/3?days=7&amp;minRuns=2"');
    expect(html).toContain('href="/repos/3?days=7&amp;minRuns=2&amp;page=3"');
  });

  it("offers only Previous on the last page", () => {
    const html = renderToStaticMarkup(<Pagination repoId={3} params={{ ...DEFAULT_PARAMS, page: 3 }} total={45} />);
    expect(html).toContain("Previous");
    expect(html).not.toContain("Next");
  });
});

describe("Overview", () => {
  it("renders the repo name, window selector with the current window marked, cards and table", () => {
    const html = renderToStaticMarkup(
      <Overview repoId={3} params={DEFAULT_PARAMS} summary={summary} flaky={{ data: [row()], total: 1 }} now={now} />,
    );
    expect(html).toContain("<h1>flakehunter-demo/storefront</h1>");
    expect(html).toContain('href="/repos/3?days=7"');
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(/aria-current="page"[^>]*>30 days</);
    expect(html).toContain('href="/repos/3?days=90"');
    expect(html).toContain("Flakiest tests");
    expect(html).toContain("retriesOnTimeout");
    expect(html).toContain('name="minRuns"');
    expect(html).toContain('name="days" value="30"');
  });

  it("explains an empty result instead of drawing an empty table", () => {
    const html = renderToStaticMarkup(
      <Overview repoId={3} params={DEFAULT_PARAMS} summary={summary} flaky={{ data: [], total: 0 }} now={now} />,
    );
    expect(html).not.toContain("<table");
    expect(html).toContain("No flaky tests in the last 30 days");
  });
});

describe("EmptyFlakyTests", () => {
  it("only suggests lowering the minimum when it can be lowered", () => {
    expect(renderToStaticMarkup(<EmptyFlakyTests params={{ days: 7, minRuns: 1, page: 1 }} />)).not.toContain(
      "Lowering",
    );
    expect(renderToStaticMarkup(<EmptyFlakyTests params={DEFAULT_PARAMS} />)).toContain("Lowering");
  });
});

describe("ErrorState", () => {
  it("is an alert with the request id when there is one", () => {
    const html = renderToStaticMarkup(
      <ErrorState title="Cannot reach the API" message="Try later." requestId="req-9" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Cannot reach the API");
    expect(html).toContain("req-9");
  });
});
