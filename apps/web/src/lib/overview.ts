// Pure helpers for the overview page: URL search params in, API query values and links out. No React, no I/O.

export const WINDOW_OPTIONS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_OPTIONS)[number];

export const DEFAULT_DAYS: WindowDays = 30;
export const DEFAULT_MIN_RUNS = 5;
export const PAGE_SIZE = 20;
const MAX_MIN_RUNS = 1000;
const MAX_PAGE = 10_000;

export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface OverviewParams {
  days: WindowDays;
  minRuns: number;
  /** 1-based page number. */
  page: number;
}

export const DEFAULT_PARAMS: OverviewParams = { days: DEFAULT_DAYS, minRuns: DEFAULT_MIN_RUNS, page: 1 };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseInteger(value: string | string[] | undefined, min: number, max: number): number | undefined {
  const text = first(value);
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
}

/** Reads `?days=&minRuns=&page=`. Anything missing, malformed or out of range falls back to its default. */
export function parseOverviewParams(raw: RawSearchParams): OverviewParams {
  const days = parseInteger(raw.days, 1, 365);
  return {
    days: WINDOW_OPTIONS.find((option) => option === days) ?? DEFAULT_PARAMS.days,
    minRuns: parseInteger(raw.minRuns, 1, MAX_MIN_RUNS) ?? DEFAULT_PARAMS.minRuns,
    page: parseInteger(raw.page, 1, MAX_PAGE) ?? DEFAULT_PARAMS.page,
  };
}

/** The `since` timestamp for a window of `days` days ending now. */
export function sinceFor(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Link to the overview with `changes` applied on top of `current`; values equal to the default are left out. */
export function overviewHref(repoId: number, current: OverviewParams, changes: Partial<OverviewParams> = {}): string {
  const next = { ...current, ...changes };
  const search = new URLSearchParams();
  if (next.days !== DEFAULT_PARAMS.days) search.set("days", String(next.days));
  if (next.minRuns !== DEFAULT_PARAMS.minRuns) search.set("minRuns", String(next.minRuns));
  if (next.page !== DEFAULT_PARAMS.page) search.set("page", String(next.page));
  const query = search.toString();
  return `/repos/${repoId}${query ? `?${query}` : ""}`;
}

export function pageCount(total: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Result position for the page-th page, e.g. "21-40 of 57"; "0 of 0" when empty. */
export function pageRange(page: number, total: number, pageSize: number = PAGE_SIZE): string {
  if (total === 0) return "0 of 0";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return `${start}-${end} of ${total}`;
}

/** 0.384 -> "38.4%"; null (no data) -> a dash. */
export function formatPercent(rate: number | null, digits = 1): string {
  if (rate === null) return "–";
  return `${(rate * 100).toFixed(digits)}%`;
}

const UNITS: [limit: number, size: number, name: string][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [30 * 86_400, 86_400, "day"],
];

/** "3 hours ago", "2 days ago"; falls back to the ISO date beyond ~30 days. Invalid input yields a dash. */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "–";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "–";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return "just now";
  for (const [limit, size, name] of UNITS) {
    if (seconds < limit) {
      const count = Math.max(1, Math.floor(seconds / size));
      return seconds < 5 ? "just now" : `${count} ${name}${count === 1 ? "" : "s"} ago`;
    }
  }
  return then.toISOString().slice(0, 10);
}
