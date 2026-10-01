import { createHash } from "node:crypto";
import { DEMO_TESTS, type DemoTest } from "./catalog.js";
import { buildJunitXml, type JunitCase, type JunitSuite } from "./junit.js";

// Pure and deterministic: every random draw comes from a PRNG keyed on (seed, calendar day, commit, attempt), never
// on the clock. Regenerating later therefore reproduces earlier runs byte for byte, so re-seeding is a no-op for them.
// Only node built-ins are imported, because scripts at the repo root cannot resolve the API's dependencies.

export const DEFAULT_DEMO_SEED = 42;

export interface DemoReport {
  /** The X-FH-Report-Key to upload this report under. */
  reportKey: string;
  xml: string;
}

export interface DemoRun {
  runId: number;
  attempt: number;
  headSha: string;
  branch: string;
  workflow: string;
  timestamp: Date;
  reports: DemoReport[];
}

export interface GenerateOptions {
  seed: number;
  /** How many whole calendar days (UTC) before today the history starts. */
  days: number;
  /** The clock: no run is generated after it. */
  now: Date;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const WORKFLOW = "CI";
const FEATURE_BRANCHES = [
  "feature/checkout-redesign",
  "fix/payment-timeout",
  "chore/deps-update",
  "feature/gift-cards",
];
/** Share of commits on a feature branch, of commits uploaded as two reports, and of failed first attempts re-run. */
const FEATURE_BRANCH_SHARE = 0.2;
const SPLIT_REPORT_SHARE = 0.3;
const RERUN_SHARE = 0.75;

type Rng = () => number;

/** mulberry32 seeded from a hash of the key parts. */
function rngFor(...parts: (string | number)[]): Rng {
  let a = createHash("sha1").update(parts.join(":")).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stackFor(test: DemoTest): string {
  const simpleName = test.classname.split(".").at(-1);
  const line = 20 + (createHash("sha1").update(`${test.classname}::${test.name}`).digest().readUInt16BE(0) % 180);
  return [
    `at ${test.classname}.${test.name}(${simpleName}.java:${line})`,
    "at java.base/java.util.concurrent.FutureTask.run(FutureTask.java:264)",
    "at org.junit.platform.engine.support.hierarchical.NodeTestTask.executeRecursively(NodeTestTask.java:151)",
  ].join("\n");
}

/** One test's testcase entries for one attempt: usually one, more when in-suite retries kick in. */
function runTest(test: DemoTest, rng: Rng, ageDays: number): JunitCase[] {
  const [low, high] = test.kind === "unit" ? [0.005, 0.4] : [0.6, 4];
  const duration = () => low + rng() * (high - low);
  const base = { classname: test.classname, name: test.name };
  const behaviour = test.behaviour;

  switch (behaviour.type) {
    case "stable":
      return [{ ...base, timeSeconds: duration(), outcome: "passed" }];
    case "skipped":
      return [{ ...base, timeSeconds: 0, outcome: "skipped" }];
    case "failing-until": {
      const timeSeconds = duration();
      if (ageDays <= behaviour.fixedDaysAgo) return [{ ...base, timeSeconds, outcome: "passed" }];
      return [
        {
          ...base,
          timeSeconds,
          outcome: "failed",
          message: behaviour.message,
          type: behaviour.exception,
          stack: stackFor(test),
        },
      ];
    }
    case "flaky": {
      const active =
        (behaviour.activeFromDaysAgo === undefined || ageDays <= behaviour.activeFromDaysAgo) &&
        (behaviour.activeUntilDaysAgo === undefined || ageDays >= behaviour.activeUntilDaysAgo);
      const entries: JunitCase[] = [];
      for (let attempt = 0; attempt <= behaviour.retries; attempt++) {
        // Always draw, so the RNG stream does not depend on whether the test happens to be flaky today.
        const draw = rng();
        const timeSeconds = duration();
        if (active && draw < behaviour.failProbability) {
          entries.push({
            ...base,
            timeSeconds,
            outcome: behaviour.failureKind === "error" ? "error" : "failed",
            message: behaviour.message,
            type: behaviour.exception,
            stack: stackFor(test),
          });
        } else {
          entries.push({ ...base, timeSeconds, outcome: "passed" });
          break;
        }
      }
      return entries;
    }
  }
}

/** Runs the whole catalog once and groups the entries into one suite per class. */
function runCatalog(rng: Rng, ageDays: number) {
  const suites = new Map<string, JunitSuite & { kind: DemoTest["kind"] }>();
  let failed = false;
  for (const test of DEMO_TESTS) {
    const entries = runTest(test, rng, ageDays);
    const last = entries.at(-1);
    if (last && (last.outcome === "failed" || last.outcome === "error")) failed = true;
    const suite = suites.get(test.classname) ?? { name: test.classname, kind: test.kind, cases: [] };
    suite.cases.push(...entries);
    suites.set(test.classname, suite);
  }
  return { suites: [...suites.values()], failed };
}

function toReports(suites: ReturnType<typeof runCatalog>["suites"], split: boolean): DemoReport[] {
  if (!split) return [{ reportKey: "default", xml: buildJunitXml(suites) }];
  return (["unit", "integration"] as const).map((kind) => ({
    reportKey: kind,
    xml: buildJunitXml(suites.filter((s) => s.kind === kind)),
  }));
}

function commitsOnDay(seed: number, dateKey: string, dayOfWeek: number): number {
  const rng = rngFor(seed, "day", dateKey);
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  return weekend ? (rng() < 0.2 ? 1 : 0) : 2 + Math.floor(rng() * 3);
}

/**
 * Generates the fake CI history for a demo repo: roughly two to four commits per weekday, each run once and
 * re-run when it failed (so flaky tests show up as a pass and a fail on one commit), sorted oldest first.
 */
export function generateDemoRuns({ seed, days, now }: GenerateOptions): DemoRun[] {
  const nowMs = now.getTime();
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const runs: DemoRun[] = [];

  for (let ageDays = Math.max(0, Math.floor(days)); ageDays >= 0; ageDays--) {
    const dayStart = todayStart - ageDays * DAY_MS;
    const dateKey = new Date(dayStart).toISOString().slice(0, 10);
    const dayNumber = Math.floor(dayStart / DAY_MS);
    const commitCount = commitsOnDay(seed, dateKey, new Date(dayStart).getUTCDay());

    for (let index = 0; index < commitCount; index++) {
      // All of a commit's decisions are drawn up front from its own stream, so skipping a commit that lies in
      // the future (or a rerun that does) never shifts the draws of any other.
      const rng = rngFor(seed, "commit", dateKey, index);
      const offset = (index + rng()) * ((9 * HOUR_MS) / commitCount);
      const onFeatureBranch = rng() < FEATURE_BRANCH_SHARE;
      const branchPick = rng();
      const split = rng() < SPLIT_REPORT_SHARE;
      const rerun = rng() < RERUN_SHARE;
      const rerunGapMinutes = 10 + Math.floor(rng() * 30);

      const firstAttemptAt = Math.floor((dayStart + 9 * HOUR_MS + offset) / 1000) * 1000;
      const headSha = createHash("sha1").update(`${seed}:${dateKey}:${index}`).digest("hex");
      // Run ids embed the seed so a different seed never collides with (and is never swallowed by) an earlier one.
      const runId = 1_000_000_000 + (seed % 1000) * 10_000_000 + dayNumber * 100 + index;
      const branch = onFeatureBranch
        ? (FEATURE_BRANCHES[Math.floor(branchPick * FEATURE_BRANCHES.length)] ?? "main")
        : "main";

      for (let attempt = 1; attempt <= 2; attempt++) {
        const at = attempt === 1 ? firstAttemptAt : firstAttemptAt + rerunGapMinutes * MINUTE_MS;
        if (at > nowMs) break;

        const { suites, failed } = runCatalog(rngFor(seed, "attempt", dateKey, index, attempt), ageDays);
        runs.push({
          runId,
          attempt,
          headSha,
          branch,
          workflow: WORKFLOW,
          timestamp: new Date(at),
          reports: toReports(suites, split),
        });
        if (!failed || !rerun) break;
      }
    }
  }

  return runs.sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.runId - b.runId || a.attempt - b.attempt,
  );
}
