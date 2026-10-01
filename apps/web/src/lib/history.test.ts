import { describe, expect, it } from "bun:test";
import {
  buildChart,
  DEFAULT_HISTORY_PARAMS,
  flakyShas,
  formatDateTime,
  formatDay,
  formatDuration,
  type HistoryItem,
  historyHref,
  parseHistoryParams,
  safeHttpUrl,
  shortSha,
} from "./history";

let nextId = 1;
function item(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    resultId: nextId++,
    status: "passed",
    headSha: "a".repeat(40),
    headBranch: "main",
    occurrenceIndex: 0,
    durationSeconds: 1,
    failureMessage: null,
    createdAt: "2026-03-30T12:00:00.000Z",
    run: { id: 1, githubRunId: 100, attempt: 1, workflowName: "CI", htmlUrl: null },
    ...over,
  };
}

describe("parseHistoryParams", () => {
  it("defaults", () => {
    expect(parseHistoryParams({})).toEqual(DEFAULT_HISTORY_PARAMS);
  });

  it("accepts valid values", () => {
    expect(parseHistoryParams({ days: "7", status: "failed", page: "3" })).toEqual({
      days: 7,
      status: "failed",
      page: 3,
    });
  });

  it("falls back for unknown or malformed values", () => {
    expect(parseHistoryParams({ days: "14", status: "exploded", page: "0" })).toEqual(DEFAULT_HISTORY_PARAMS);
    expect(parseHistoryParams({ page: "-2" }).page).toBe(1);
    expect(parseHistoryParams({ status: ["error", "passed"] }).status).toBe("error");
  });
});

describe("historyHref", () => {
  it("omits defaults and keeps the rest", () => {
    expect(historyHref(3, 63, DEFAULT_HISTORY_PARAMS)).toBe("/repos/3/tests/63");
    expect(historyHref(3, 63, { days: 7, status: "failed", page: 2 })).toBe(
      "/repos/3/tests/63?days=7&status=failed&page=2",
    );
  });

  it("can clear the status filter", () => {
    const current = { days: 30 as const, status: "failed" as const, page: 1 };
    expect(historyHref(3, 63, current, { status: undefined })).toBe("/repos/3/tests/63");
  });
});

describe("flakyShas", () => {
  const sha = (c: string) => c.repeat(40);

  it("flags a commit with both a pass and a failure or error", () => {
    const items = [
      item({ headSha: sha("a"), status: "passed" }),
      item({ headSha: sha("a"), status: "failed" }),
      item({ headSha: sha("b"), status: "passed" }),
      item({ headSha: sha("c"), status: "error" }),
      item({ headSha: sha("c"), status: "passed" }),
    ];
    expect([...flakyShas(items)].sort()).toEqual([sha("a"), sha("c")]);
  });

  it("does not flag all-pass, all-fail or skip-only commits", () => {
    const items = [
      item({ headSha: sha("a"), status: "passed" }),
      item({ headSha: sha("a"), status: "passed" }),
      item({ headSha: sha("b"), status: "failed" }),
      item({ headSha: sha("b"), status: "error" }),
      item({ headSha: sha("c"), status: "skipped" }),
      item({ headSha: sha("c"), status: "passed" }),
    ];
    expect(flakyShas(items).size).toBe(0);
  });
});

describe("formatting", () => {
  it("shortens a sha", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });

  it("formats days and date-times in UTC", () => {
    expect(formatDay("2026-03-30T23:59:00.000Z")).toBe("Mar 30");
    expect(formatDateTime("2026-03-30T14:05:59.000Z")).toBe("2026-03-30 14:05 UTC");
    expect(formatDay("nope")).toBe("–");
    expect(formatDateTime("nope")).toBe("–");
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(-1)).toBe("–");
    expect(formatDuration(0.1234)).toBe("123 ms");
    expect(formatDuration(1.25)).toBe("1.3 s");
    expect(formatDuration(125)).toBe("2m 05s");
  });
});

describe("safeHttpUrl", () => {
  it("allows only http and https", () => {
    expect(safeHttpUrl("https://github.com/o/r/actions/runs/1")).toBe("https://github.com/o/r/actions/runs/1");
    expect(safeHttpUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("buildChart", () => {
  it("has no points for no results", () => {
    const chart = buildChart([]);
    expect(chart.points).toEqual([]);
    expect(chart.ticks).toEqual([]);
    expect(chart.lanes.map((lane) => lane.status)).toEqual(["passed", "failed", "error", "skipped"]);
  });

  it("places points left to right by time regardless of input order, inside the plot", () => {
    const items = [
      item({ createdAt: "2026-03-30T00:00:00.000Z" }),
      item({ createdAt: "2026-03-10T00:00:00.000Z" }),
      item({ createdAt: "2026-03-20T00:00:00.000Z" }),
    ];
    const chart = buildChart(items);
    const xs = chart.points.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBe(chart.plot.left);
    expect(xs[2]).toBe(chart.plot.right);
    expect(xs[1]).toBeCloseTo((chart.plot.left + chart.plot.right) / 2, 0);
    expect(chart.points.map((p) => p.at)[0]).toBe("2026-03-10T00:00:00.000Z");
  });

  it("puts each status on its own lane", () => {
    const chart = buildChart([item({ status: "passed" }), item({ status: "failed" }), item({ status: "skipped" })]);
    const lane = (status: string) => chart.lanes.find((l) => l.status === status)?.y;
    const y = (status: string) => chart.points.find((p) => p.status === status)?.y;
    expect(y("passed")).toBe(lane("passed"));
    expect(y("failed")).toBe(lane("failed"));
    expect(y("skipped")).toBe(lane("skipped"));
    expect(new Set(chart.lanes.map((l) => l.y)).size).toBe(4);
  });

  it("marks only points on flaky commits", () => {
    const flaky = "f".repeat(40);
    const chart = buildChart([
      item({ headSha: flaky, status: "passed" }),
      item({ headSha: flaky, status: "failed" }),
      item({ headSha: "1".repeat(40), status: "passed" }),
    ]);
    expect(chart.points.filter((p) => p.flaky).map((p) => p.sha)).toEqual([flaky, flaky]);
    expect(chart.points.filter((p) => !p.flaky)).toHaveLength(1);
  });

  it("centres a single point or results that share one instant, and counts lanes", () => {
    const chart = buildChart([item(), item({ status: "failed" })]);
    const centre = (chart.plot.left + chart.plot.right) / 2;
    expect(chart.points.every((p) => p.x === centre)).toBe(true);
    expect(chart.ticks).toHaveLength(1);
    expect(chart.lanes.find((l) => l.status === "failed")?.count).toBe(1);
  });

  it("ignores results with an unparseable timestamp", () => {
    const chart = buildChart([item({ createdAt: "garbage" }), item()]);
    expect(chart.points).toHaveLength(1);
  });

  it("labels the first, middle and last day", () => {
    const chart = buildChart([
      item({ createdAt: "2026-03-10T00:00:00.000Z" }),
      item({ createdAt: "2026-03-30T00:00:00.000Z" }),
    ]);
    expect(chart.ticks.map((t) => t.label)).toEqual(["Mar 10", "Mar 20", "Mar 30"]);
  });
});
