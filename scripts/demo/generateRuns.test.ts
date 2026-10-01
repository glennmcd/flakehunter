import { describe, expect, it } from "bun:test";
import { type ParsedSuite, parseJunitXml } from "../../apps/api/src/ingest/junitParser.js";
import { DEMO_TESTS, type DemoTest, testKey } from "./catalog.js";
import { DEFAULT_DEMO_SEED, type DemoRun, generateDemoRuns } from "./generateRuns.js";

const DAY = 24 * 60 * 60 * 1000;
// A Thursday afternoon, so "today" has a few commits and the window contains a full run of weekdays.
const NOW = new Date("2026-10-01T15:00:00.000Z");
const options = { seed: DEFAULT_DEMO_SEED, days: 30, now: NOW };

const runs = generateDemoRuns(options);

type Status = "passed" | "failed" | "error" | "skipped";

/** Every parsed testcase of a run, in document order. */
function casesOf(run: DemoRun) {
  return run.reports.flatMap((r) => parseJunitXml(r.xml).flatMap((s: ParsedSuite) => s.testCases));
}

/** Whole calendar days (UTC) before "today" that the run happened; 0 means today. */
function daysAgo(run: DemoRun) {
  return Math.floor(NOW.getTime() / DAY) - Math.floor(run.timestamp.getTime() / DAY);
}

/** For one test: its status on each run attempt, taking the first try (in-suite retries come after). */
function firstTryStatuses(all: DemoRun[], key: string): { run: DemoRun; status: Status }[] {
  const out: { run: DemoRun; status: Status }[] = [];
  for (const run of all) {
    const hit = casesOf(run).find((c) => testKey(c) === key);
    if (hit) out.push({ run, status: hit.status });
  }
  return out;
}

const byBehaviour = <T extends DemoTest["behaviour"]["type"]>(type: T) =>
  DEMO_TESTS.filter((t): t is DemoTest & { behaviour: { type: T } } => t.behaviour.type === type);

describe("catalog", () => {
  it("has about 45 tests with unique identities", () => {
    expect(DEMO_TESTS.length).toBeGreaterThanOrEqual(40);
    expect(DEMO_TESTS.length).toBeLessThanOrEqual(50);
    expect(new Set(DEMO_TESTS.map(testKey)).size).toBe(DEMO_TESTS.length);
  });

  it("mixes mostly stable tests with a few flaky ones, one fixed failure and some skips", () => {
    expect(byBehaviour("flaky")).toHaveLength(6);
    expect(byBehaviour("failing-until")).toHaveLength(1);
    expect(byBehaviour("skipped").length).toBeGreaterThanOrEqual(2);
    expect(byBehaviour("stable").length).toBeGreaterThan(30);
  });
});

describe("generateDemoRuns", () => {
  it("is deterministic for a seed and differs for another seed", () => {
    expect(generateDemoRuns(options)).toEqual(runs);
    const other = generateDemoRuns({ ...options, seed: DEFAULT_DEMO_SEED + 1 });
    expect(other.map((r) => r.headSha)).not.toEqual(runs.map((r) => r.headSha));
    expect(new Set(other.map((r) => r.runId)).size).toBeGreaterThan(0);
    expect(other.some((r) => runs.some((x) => x.runId === r.runId))).toBe(false);
  });

  it("produces a realistic volume of runs over the window", () => {
    const commits = new Set(runs.map((r) => r.headSha));
    expect(commits.size).toBeGreaterThan(40);
    expect(commits.size).toBeLessThan(120);
    expect(runs.length).toBeGreaterThan(commits.size); // some commits were re-run
  });

  it("has well-formed identifiers, ordered timestamps inside the window and never in the future", () => {
    for (const run of runs) {
      expect(run.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isSafeInteger(run.runId) && run.runId > 0).toBe(true);
      expect(run.timestamp.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(run.timestamp.getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 31 * DAY);
      expect(run.branch.length).toBeGreaterThan(0);
      expect(run.workflow).toBe("CI");
    }
    const times = runs.map((r) => r.timestamp.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("numbers attempts from 1 per run id, keeps one SHA per run id, and never repeats (run, attempt)", () => {
    const seen = new Set<string>();
    const shaByRun = new Map<number, string>();
    const attemptsByRun = new Map<number, number[]>();
    for (const run of runs) {
      const key = `${run.runId}:${run.attempt}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(shaByRun.get(run.runId) ?? run.headSha).toBe(run.headSha);
      shaByRun.set(run.runId, run.headSha);
      attemptsByRun.set(run.runId, [...(attemptsByRun.get(run.runId) ?? []), run.attempt]);
    }
    for (const attempts of attemptsByRun.values()) {
      expect(attempts).toEqual(attempts.map((_, i) => i + 1));
    }
    expect([...attemptsByRun.values()].some((a) => a.length > 1)).toBe(true);
  });

  it("is stable when the same days are regenerated later in the same day", () => {
    const later = generateDemoRuns({ ...options, now: new Date("2026-10-01T23:00:00.000Z") });
    // Everything generated at 15:00 appears again, byte for byte, so re-seeding is a no-op for those runs.
    for (const run of runs) {
      expect(later.find((r) => r.runId === run.runId && r.attempt === run.attempt)).toEqual(run);
    }
  });

  it("emits parseable JUnit whose suite counts match the testcases", () => {
    for (const run of runs) {
      expect(run.reports.length).toBeGreaterThan(0);
      for (const report of run.reports) {
        const suites = parseJunitXml(report.xml);
        expect(suites.length).toBeGreaterThan(0);
        for (const suite of suites) {
          const count = (s: Status) => suite.testCases.filter((t) => t.status === s).length;
          expect(suite.tests).toBe(suite.testCases.length);
          expect(suite.failures).toBe(count("failed"));
          expect(suite.errors).toBe(count("error"));
          expect(suite.skipped).toBe(count("skipped"));
        }
      }
    }
  });

  it("runs the whole catalog on every run, whether uploaded as one report or split in two", () => {
    const keysSeen = new Set<string>();
    for (const run of runs) {
      const keys = run.reports.map((r) => r.reportKey);
      expect(new Set(keys).size).toBe(keys.length);
      keysSeen.add(keys.slice().sort().join("+"));
      const present = new Set(casesOf(run).map(testKey));
      for (const test of DEMO_TESTS) expect(present.has(testKey(test))).toBe(true);
    }
    expect(keysSeen).toContain("default");
    expect(keysSeen).toContain("integration+unit");
  });

  it("never fails a stable test and always skips the skipped ones", () => {
    for (const test of byBehaviour("stable")) {
      for (const { status } of firstTryStatuses(runs, testKey(test))) expect(status).toBe("passed");
    }
    for (const test of byBehaviour("skipped")) {
      for (const { status } of firstTryStatuses(runs, testKey(test))) expect(status).toBe("skipped");
    }
  });

  it("fails each always-active flaky test at roughly its configured rate", () => {
    const long = generateDemoRuns({ seed: DEFAULT_DEMO_SEED, days: 150, now: NOW });
    const always = byBehaviour("flaky").filter(
      (t) => t.behaviour.activeFromDaysAgo === undefined && t.behaviour.activeUntilDaysAgo === undefined,
    );
    expect(always.length).toBeGreaterThanOrEqual(3);
    for (const test of always) {
      const results = firstTryStatuses(long, testKey(test));
      const failed = results.filter((r) => r.status !== "passed").length;
      expect(results.length).toBeGreaterThan(200);
      expect(Math.abs(failed / results.length - test.behaviour.failProbability)).toBeLessThan(0.06);
    }
  });

  it("starts flakiness late for one test and stops it early for another", () => {
    const starts = byBehaviour("flaky").filter((t) => t.behaviour.activeFromDaysAgo !== undefined);
    const stops = byBehaviour("flaky").filter((t) => t.behaviour.activeUntilDaysAgo !== undefined);
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);

    const late = starts[0] as (typeof starts)[number];
    const lateFails = firstTryStatuses(runs, testKey(late)).filter((r) => r.status !== "passed");
    expect(lateFails.length).toBeGreaterThan(0);
    for (const { run } of lateFails) expect(daysAgo(run)).toBeLessThanOrEqual(late.behaviour.activeFromDaysAgo ?? 0);

    const early = stops[0] as (typeof stops)[number];
    const earlyFails = firstTryStatuses(runs, testKey(early)).filter((r) => r.status !== "passed");
    expect(earlyFails.length).toBeGreaterThan(0);
    for (const { run } of earlyFails)
      expect(daysAgo(run)).toBeGreaterThanOrEqual(early.behaviour.activeUntilDaysAgo ?? 0);
  });

  it("fails the broken test on every attempt until its fix date and never after", () => {
    const [broken] = byBehaviour("failing-until");
    if (!broken) throw new Error("catalog has no failing-until test");
    const results = firstTryStatuses(runs, testKey(broken));
    const before = results.filter((r) => daysAgo(r.run) > broken.behaviour.fixedDaysAgo);
    const after = results.filter((r) => daysAgo(r.run) <= broken.behaviour.fixedDaysAgo);
    expect(before.length).toBeGreaterThan(10);
    expect(after.length).toBeGreaterThan(10);
    expect(before.every((r) => r.status === "failed")).toBe(true);
    expect(after.every((r) => r.status === "passed")).toBe(true);
  });

  it("gives every flaky test at least one commit where it both passed and failed, and no other test any", () => {
    // Same definition as the API: a commit is flaky for a test when it saw a pass and a fail/error.
    const perSha = new Map<string, Map<string, Set<Status>>>();
    for (const run of runs) {
      const tests = perSha.get(run.headSha) ?? new Map<string, Set<Status>>();
      for (const c of casesOf(run)) {
        const statuses = tests.get(testKey(c)) ?? new Set<Status>();
        statuses.add(c.status);
        tests.set(testKey(c), statuses);
      }
      perSha.set(run.headSha, tests);
    }
    const flakyShas = new Map<string, number>();
    for (const tests of perSha.values()) {
      for (const [key, statuses] of tests) {
        if (statuses.has("passed") && (statuses.has("failed") || statuses.has("error"))) {
          flakyShas.set(key, (flakyShas.get(key) ?? 0) + 1);
        }
      }
    }
    for (const test of byBehaviour("flaky")) expect(flakyShas.get(testKey(test)) ?? 0).toBeGreaterThanOrEqual(1);
    const flakyKeys = new Set(byBehaviour("flaky").map(testKey));
    for (const key of flakyShas.keys()) expect(flakyKeys.has(key)).toBe(true);
  });

  it("includes in-suite retries: the same test twice in one suite, failed then passed", () => {
    const retrying = byBehaviour("flaky")
      .filter((t) => t.behaviour.retries > 0)
      .map(testKey);
    expect(retrying.length).toBeGreaterThan(0);
    let sawRetry = false;
    let sawRecovery = false;
    for (const run of runs) {
      for (const report of run.reports) {
        for (const suite of parseJunitXml(report.xml)) {
          for (const key of retrying) {
            const entries = suite.testCases.filter((t) => testKey(t) === key);
            if (entries.length > 1) {
              sawRetry = true;
              expect(entries[0]?.status).not.toBe("passed");
              if (entries.at(-1)?.status === "passed") sawRecovery = true;
            }
          }
        }
      }
    }
    expect(sawRetry).toBe(true);
    expect(sawRecovery).toBe(true);
  });

  it("supports a short window and a zero-length one without throwing", () => {
    const short = generateDemoRuns({ ...options, days: 3 });
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((r) => r.timestamp.getTime() >= NOW.getTime() - 4 * DAY)).toBe(true);
    expect(() => generateDemoRuns({ ...options, days: 0 })).not.toThrow();
  });
});
