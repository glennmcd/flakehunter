import { describe, expect, it } from "bun:test";
import { parseJunitXml } from "../../apps/api/src/ingest/junitParser.js";
import { buildJunitXml, escapeXml } from "./junit.js";

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("leaves plain text alone", () => {
    expect(escapeXml("plain text 123")).toBe("plain text 123");
  });
});

describe("buildJunitXml", () => {
  const xml = buildJunitXml([
    {
      name: "com.acme.CartTest",
      cases: [
        { classname: "com.acme.CartTest", name: "passes", timeSeconds: 0.123, outcome: "passed" },
        {
          classname: "com.acme.CartTest",
          name: "fails",
          timeSeconds: 0.5,
          outcome: "failed",
          message: `expected: <"a & b"> but was: <'c'>`,
          type: "org.opentest4j.AssertionFailedError",
          stack: "at com.acme.CartTest.fails(CartTest.java:42)\nat org.junit.Runner.run(Runner.java:1)",
        },
        {
          classname: "com.acme.CartTest",
          name: "errors",
          timeSeconds: 1,
          outcome: "error",
          message: "Read timed out",
          type: "java.net.SocketTimeoutException",
        },
        { classname: "com.acme.CartTest", name: "skipped", timeSeconds: 0, outcome: "skipped" },
      ],
    },
    { name: "com.acme.EmptyTest", cases: [] },
  ]);

  it("is a well-formed JUnit document the API's own parser accepts", () => {
    const suites = parseJunitXml(xml);
    expect(suites.map((s) => s.suiteName)).toEqual(["com.acme.CartTest", "com.acme.EmptyTest"]);
    expect(suites[0]?.testCases.map((t) => [t.name, t.status])).toEqual([
      ["passes", "passed"],
      ["fails", "failed"],
      ["errors", "error"],
      ["skipped", "skipped"],
    ]);
    expect(suites[1]?.testCases).toEqual([]);
  });

  it("round-trips messages with special characters and keeps stack traces", () => {
    const failed = parseJunitXml(xml)[0]?.testCases[1];
    expect(failed?.failureMessage).toBe(`expected: <"a & b"> but was: <'c'>`);
    expect(failed?.failureStack).toContain("at com.acme.CartTest.fails(CartTest.java:42)");
    expect(failed?.failureStack).toContain("at org.junit.Runner.run(Runner.java:1)");
  });

  it("carries durations and per-suite counts", () => {
    const [suite] = parseJunitXml(xml);
    expect(suite?.testCases[0]?.durationSeconds).toBe(0.123);
    expect(suite).toMatchObject({ tests: 4, failures: 1, errors: 1, skipped: 1 });
    expect(suite?.timeSeconds).toBeCloseTo(1.623, 5);
  });

  it("starts with an XML declaration", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});
