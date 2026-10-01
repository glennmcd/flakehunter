import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PARAMS,
  formatPercent,
  formatRelativeTime,
  overviewHref,
  pageCount,
  pageRange,
  parseOverviewParams,
  sinceFor,
} from "./overview";

describe("parseOverviewParams", () => {
  it("uses defaults for an empty query", () => {
    expect(parseOverviewParams({})).toEqual({ days: 30, minRuns: 5, page: 1 });
  });

  it("accepts valid values", () => {
    expect(parseOverviewParams({ days: "7", minRuns: "10", page: "3" })).toEqual({ days: 7, minRuns: 10, page: 3 });
    expect(parseOverviewParams({ days: "90" }).days).toBe(90);
  });

  it("falls back to defaults for malformed or out-of-range values", () => {
    expect(parseOverviewParams({ days: "14" }).days).toBe(30);
    expect(parseOverviewParams({ days: "abc", minRuns: "-1", page: "0" })).toEqual(DEFAULT_PARAMS);
    expect(parseOverviewParams({ minRuns: "1.5", page: "2e3" })).toEqual(DEFAULT_PARAMS);
    expect(parseOverviewParams({ minRuns: "0" }).minRuns).toBe(5);
    expect(parseOverviewParams({ minRuns: "99999" }).minRuns).toBe(5);
  });

  it("uses the first value when a parameter is repeated", () => {
    expect(parseOverviewParams({ days: ["7", "90"], page: ["2", "5"] })).toMatchObject({ days: 7, page: 2 });
  });
});

describe("sinceFor", () => {
  it("subtracts whole days from the given time", () => {
    const now = new Date("2026-03-31T12:00:00.000Z");
    expect(sinceFor(7, now).toISOString()).toBe("2026-03-24T12:00:00.000Z");
    expect(sinceFor(90, now).toISOString()).toBe("2025-12-31T12:00:00.000Z");
  });
});

describe("overviewHref", () => {
  it("omits defaults", () => {
    expect(overviewHref(3, DEFAULT_PARAMS)).toBe("/repos/3");
  });

  it("includes non-default values", () => {
    expect(overviewHref(3, { days: 7, minRuns: 5, page: 1 })).toBe("/repos/3?days=7");
    expect(overviewHref(3, DEFAULT_PARAMS, { days: 90, minRuns: 2, page: 4 })).toBe(
      "/repos/3?days=90&minRuns=2&page=4",
    );
  });

  it("resets nothing implicitly: callers choose what to change", () => {
    const current = { days: 7 as const, minRuns: 8, page: 3 };
    expect(overviewHref(3, current, { page: 4 })).toBe("/repos/3?days=7&minRuns=8&page=4");
    expect(overviewHref(3, current, { days: 30, page: 1 })).toBe("/repos/3?minRuns=8");
  });
});

describe("paging", () => {
  it("counts pages, with at least one", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(20)).toBe(1);
    expect(pageCount(21)).toBe(2);
    expect(pageCount(57, 10)).toBe(6);
  });

  it("describes the visible range", () => {
    expect(pageRange(1, 0)).toBe("0 of 0");
    expect(pageRange(1, 57)).toBe("1-20 of 57");
    expect(pageRange(3, 57)).toBe("41-57 of 57");
  });
});

describe("formatPercent", () => {
  it("formats a rate as a percentage", () => {
    expect(formatPercent(0.3793)).toBe("37.9%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0.5, 0)).toBe("50%");
  });

  it("shows a dash for no data", () => {
    expect(formatPercent(null)).toBe("–");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-03-31T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("describes recent times", () => {
    expect(formatRelativeTime(ago(1000), now)).toBe("just now");
    expect(formatRelativeTime(ago(90 * 1000), now)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(5 * 3600 * 1000), now)).toBe("5 hours ago");
    expect(formatRelativeTime(ago(2 * 86_400_000), now)).toBe("2 days ago");
  });

  it("falls back to a date for old timestamps", () => {
    expect(formatRelativeTime("2026-01-05T08:00:00.000Z", now)).toBe("2026-01-05");
  });

  it("handles null, invalid and future input", () => {
    expect(formatRelativeTime(null, now)).toBe("–");
    expect(formatRelativeTime("nonsense", now)).toBe("–");
    expect(formatRelativeTime(ago(-60_000), now)).toBe("just now");
  });
});
