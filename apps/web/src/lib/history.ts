// Pure helpers for the test detail page: URL params, flaky-commit detection, chart geometry and formatting.
import type { TestHistoryResponse } from "@flakehunter/shared-types";
import { DEFAULT_DAYS, PAGE_SIZE, type RawSearchParams, WINDOW_OPTIONS, type WindowDays } from "./overview";

export type HistoryItem = TestHistoryResponse["data"][number];
export type TestStatus = HistoryItem["status"];

export const STATUSES: readonly TestStatus[] = ["passed", "failed", "error", "skipped"];
/** The API's largest page; the timeline plots at most this many of the newest results. */
export const CHART_LIMIT = 200;
export { PAGE_SIZE };

export interface HistoryParams {
  days: WindowDays;
  status: TestStatus | undefined;
  /** 1-based page of the table. */
  page: number;
}

export const DEFAULT_HISTORY_PARAMS: HistoryParams = { days: DEFAULT_DAYS, status: undefined, page: 1 };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Reads `?days=&status=&page=`; anything missing, malformed or unknown falls back to its default. */
export function parseHistoryParams(raw: RawSearchParams): HistoryParams {
  const days = first(raw.days);
  const status = first(raw.status);
  const page = first(raw.page);
  const pageNumber = page !== undefined && /^\d+$/.test(page) ? Number(page) : 0;
  return {
    days: WINDOW_OPTIONS.find((option) => String(option) === days) ?? DEFAULT_HISTORY_PARAMS.days,
    status: STATUSES.find((option) => option === status),
    page: pageNumber >= 1 && pageNumber <= 10_000 ? pageNumber : 1,
  };
}

export function historyHref(
  repoId: number,
  testId: number,
  current: HistoryParams,
  changes: Partial<HistoryParams> = {},
): string {
  const next = { ...current, ...changes };
  const search = new URLSearchParams();
  if (next.days !== DEFAULT_HISTORY_PARAMS.days) search.set("days", String(next.days));
  if (next.status !== undefined) search.set("status", next.status);
  if (next.page !== 1) search.set("page", String(next.page));
  const query = search.toString();
  return `/repos/${repoId}/tests/${testId}${query ? `?${query}` : ""}`;
}

/** Commits (head SHAs) where the test both passed and failed or errored: the definition of flaky. Skips are ignored. */
export function flakyShas(items: readonly HistoryItem[]): Set<string> {
  const seen = new Map<string, { passed: boolean; failed: boolean }>();
  for (const item of items) {
    const entry = seen.get(item.headSha) ?? { passed: false, failed: false };
    if (item.status === "passed") entry.passed = true;
    else if (item.status === "failed" || item.status === "error") entry.failed = true;
    seen.set(item.headSha, entry);
  }
  const flaky = new Set<string>();
  for (const [sha, entry] of seen) if (entry.passed && entry.failed) flaky.add(sha);
  return flaky;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 30" in UTC; a dash for an invalid timestamp. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "2026-03-30 14:05 UTC": fixed format and zone, so server and viewer always agree. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/** Only http(s) links are rendered as links, so a stored `javascript:` URL can never become a clickable one. */
export function safeHttpUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export interface ChartPoint {
  resultId: number;
  x: number;
  y: number;
  status: TestStatus;
  sha: string;
  at: string;
  flaky: boolean;
}

export interface ChartModel {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  lanes: { status: TestStatus; y: number; count: number }[];
  points: ChartPoint[];
  ticks: { x: number; label: string }[];
}

/**
 * Geometry for the timeline: time runs left to right, one lane per status. `items` may be in any order.
 * Points on a commit with both a pass and a fail are marked `flaky`. Numbers are rounded to 0.1 so markup is stable.
 */
export function buildChart(items: readonly HistoryItem[], width = 720, height = 220): ChartModel {
  const plot = { left: 76, right: width - 16, top: 20, bottom: height - 36 };
  const flaky = flakyShas(items);
  const round = (n: number) => Math.round(n * 10) / 10;

  const lanes = STATUSES.map((status, index) => ({
    status,
    y: round(plot.top + (index * (plot.bottom - plot.top)) / (STATUSES.length - 1)),
    count: items.filter((item) => item.status === status).length,
  }));
  const laneY = new Map(lanes.map((lane) => [lane.status, lane.y]));

  const dated = items
    .map((item) => ({ item, time: new Date(item.createdAt).getTime() }))
    .filter((entry) => !Number.isNaN(entry.time))
    .sort((a, b) => a.time - b.time || a.item.resultId - b.item.resultId);

  const firstEntry = dated[0];
  const lastEntry = dated[dated.length - 1];
  if (!firstEntry || !lastEntry) return { width, height, plot, lanes, points: [], ticks: [] };

  const first = firstEntry.time;
  const last = lastEntry.time;
  const span = last - first;
  const xFor = (time: number) =>
    round(span === 0 ? (plot.left + plot.right) / 2 : plot.left + ((time - first) / span) * (plot.right - plot.left));

  const points = dated.map(({ item, time }) => ({
    resultId: item.resultId,
    x: xFor(time),
    y: laneY.get(item.status) ?? plot.top,
    status: item.status,
    sha: item.headSha,
    at: item.createdAt,
    flaky: flaky.has(item.headSha),
  }));

  const tickTimes = span === 0 ? [first] : [first, first + span / 2, last];
  const ticks = tickTimes.map((time) => ({ x: xFor(time), label: formatDay(new Date(time).toISOString()) }));
  return { width, height, plot, lanes, points, ticks };
}
