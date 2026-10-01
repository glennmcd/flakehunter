import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_HISTORY_PARAMS, type HistoryItem } from "../lib/history";
import { HistoryChart } from "./HistoryChart";
import { HistoryTable, StatusFilter, TestDetail } from "./TestDetail";

const now = new Date("2026-03-31T12:00:00.000Z");
const sha = (c: string) => c.repeat(40);

let nextId = 1;
function item(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    resultId: nextId++,
    status: "passed",
    headSha: sha("a"),
    headBranch: "main",
    occurrenceIndex: 0,
    durationSeconds: 2.5,
    failureMessage: null,
    createdAt: "2026-03-30T12:00:00.000Z",
    run: {
      id: 1,
      githubRunId: 100,
      attempt: 1,
      workflowName: "CI",
      htmlUrl: "https://github.com/o/r/actions/runs/100",
    },
    ...over,
  };
}

const flakyPair = [
  item({
    headSha: sha("f"),
    status: "failed",
    failureMessage: "expected 200 but was 503",
    createdAt: "2026-03-29T10:00:00.000Z",
  }),
  item({ headSha: sha("f"), status: "passed", createdAt: "2026-03-29T10:30:00.000Z" }),
];

describe("HistoryChart", () => {
  it("renders an accessible SVG with a summary label and a title per point", () => {
    const html = renderToStaticMarkup(<HistoryChart items={flakyPair} total={2} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("Timeline of 2 results: 1 passed, 1 failed, 0 error, 0 skipped. 1 flaky commit.");
    expect(html).toContain("Failed on fffffff at 2026-03-29 10:00 UTC, flaky commit");
    expect(html).toContain("Passed on fffffff at 2026-03-29 10:30 UTC, flaky commit");
  });

  it("uses a different shape per status, not only colour", () => {
    const html = renderToStaticMarkup(
      <HistoryChart
        items={[
          item({ status: "passed" }),
          item({ status: "failed" }),
          item({ status: "error" }),
          item({ status: "skipped" }),
        ]}
        total={4}
      />,
    );
    expect(html).toContain('class="mark mark-passed"');
    expect(html).toMatch(/<polygon class="mark mark-failed" points="[^"]*"/);
    expect(html).toMatch(/<polygon class="mark mark-error" points="[^"]*"/);
    expect(html).toContain('class="mark mark-skipped"');
    const failedPoints = html.match(/mark-failed" points="([^"]*)"/)?.[1]?.split(" ").length;
    const errorPoints = html.match(/mark-error" points="([^"]*)"/)?.[1]?.split(" ").length;
    expect(failedPoints).toBe(4);
    expect(errorPoints).toBe(3);
  });

  it("rings flaky commits only", () => {
    const html = renderToStaticMarkup(<HistoryChart items={[...flakyPair, item()]} total={3} />);
    // Two ringed points plus the legend's sample ring.
    expect(html.match(/class="flaky-ring"/g)).toHaveLength(3);
    const calm = renderToStaticMarkup(<HistoryChart items={[item(), item()]} total={2} />);
    expect(calm.match(/class="flaky-ring"/g)).toHaveLength(1);
  });

  it("says when it is showing only part of the results", () => {
    expect(renderToStaticMarkup(<HistoryChart items={[item()]} total={350} />)).toContain("newest 1 of 350");
    expect(renderToStaticMarkup(<HistoryChart items={[item()]} total={1} />)).not.toContain("newest");
  });

  it("renders nothing without results", () => {
    expect(renderToStaticMarkup(<HistoryChart items={[]} total={0} />)).toBe("");
  });
});

describe("HistoryTable", () => {
  it("shows status, short sha, run link, time and duration", () => {
    const html = renderToStaticMarkup(<HistoryTable items={[item()]} flaky={new Set()} now={now} />);
    expect(html).toContain("Passed");
    expect(html).toContain("aaaaaaa");
    expect(html).toContain('href="https://github.com/o/r/actions/runs/100"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("CI #100, attempt 1");
    expect(html).toContain("1 day ago");
    expect(html).toContain("2.5 s");
    expect(html).not.toContain("flaky commit");
  });

  it("tags flaky commits and offers the failure message in an expandable block", () => {
    const html = renderToStaticMarkup(<HistoryTable items={flakyPair} flaky={new Set([sha("f")])} now={now} />);
    expect(html).toContain("flaky commit");
    expect(html).toContain("<details");
    expect(html).toContain("expected 200 but was 503");
  });

  it("escapes failure messages", () => {
    const html = renderToStaticMarkup(
      <HistoryTable
        items={[item({ status: "failed", failureMessage: "<img src=x onerror=alert(1)>" })]}
        flaky={new Set()}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("never links an unsafe or missing run url", () => {
    const bad = item({
      run: { id: 1, githubRunId: 5, attempt: 2, workflowName: "CI", htmlUrl: "javascript:alert(1)" },
    });
    const none = item({ run: { id: 1, githubRunId: 6, attempt: 1, workflowName: "CI", htmlUrl: null } });
    const html = renderToStaticMarkup(<HistoryTable items={[bad, none]} flaky={new Set()} />);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("CI #5, attempt 2");
    expect(html).toContain("CI #6, attempt 1");
  });
});

describe("StatusFilter", () => {
  it("is a GET form that keeps the window and selects the current status", () => {
    const html = renderToStaticMarkup(
      <StatusFilter repoId={3} testId={63} params={{ days: 7, status: "failed", page: 1 }} />,
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/repos/3/tests/63"');
    expect(html).toContain('name="days" value="7"');
    expect(html).toMatch(/<option value="failed" selected/);
  });
});

describe("TestDetail", () => {
  const test = { id: 63, classname: "com.acme.PaymentGatewayIT", name: "retriesOnTimeout" };

  it("shows the test, breadcrumb, window selector, timeline and results", () => {
    const html = renderToStaticMarkup(
      <TestDetail
        repoId={3}
        test={test}
        params={DEFAULT_HISTORY_PARAMS}
        chart={{ items: flakyPair, total: 2 }}
        table={{ items: flakyPair, total: 2 }}
        now={now}
      />,
    );
    expect(html).toContain("<h1>retriesOnTimeout</h1>");
    expect(html).toContain("com.acme.PaymentGatewayIT");
    expect(html).toContain('href="/repos/3"');
    expect(html).toContain('href="/repos/3/tests/63?days=7"');
    expect(html).toContain("Timeline");
    expect(html).toContain("<svg");
    expect(html).toContain("flaky commit");
    expect(html).toContain("1-2 of 2");
  });

  it("explains an empty window instead of drawing an empty chart or table", () => {
    const html = renderToStaticMarkup(
      <TestDetail
        repoId={3}
        test={test}
        params={DEFAULT_HISTORY_PARAMS}
        chart={{ items: [], total: 0 }}
        table={{ items: [], total: 0 }}
      />,
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain('role="img"');
    expect(html).toContain("No results for this test in the last 30 days");
  });

  it("explains an empty filtered table while keeping the timeline", () => {
    const html = renderToStaticMarkup(
      <TestDetail
        repoId={3}
        test={test}
        params={{ days: 30, status: "error", page: 1 }}
        chart={{ items: flakyPair, total: 2 }}
        table={{ items: [], total: 0 }}
      />,
    );
    expect(html).toContain("No error results in the last 30 days");
    expect(html).toContain('role="img"');
  });
});
