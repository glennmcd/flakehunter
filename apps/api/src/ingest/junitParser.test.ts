import { describe, expect, it } from "bun:test";
import { parseJunitXml } from "./junitParser.js";

describe("parseJunitXml", () => {
  it("parses a single root testsuite with passed/failed/error/skipped cases", () => {
    const xml = `
      <testsuite name="Suite1" tests="4" failures="1" errors="1" skipped="1" time="1.234">
        <testcase classname="pkg.Foo" name="passes" time="0.01" />
        <testcase classname="pkg.Foo" name="fails" time="0.02">
          <failure message="assertion failed">stack trace here</failure>
        </testcase>
        <testcase classname="pkg.Foo" name="errors" time="0.03">
          <error message="boom">error stack</error>
        </testcase>
        <testcase classname="pkg.Foo" name="skipped" time="0.00">
          <skipped />
        </testcase>
      </testsuite>
    `;

    const suites = parseJunitXml(xml);
    expect(suites).toHaveLength(1);
    expect(suites[0]?.suiteName).toBe("Suite1");
    expect(suites[0]?.testCases).toHaveLength(4);

    const byName = Object.fromEntries((suites[0]?.testCases ?? []).map((tc) => [tc.name, tc]));
    expect(byName.passes?.status).toBe("passed");
    expect(byName.fails?.status).toBe("failed");
    expect(byName.fails?.failureMessage).toBe("assertion failed");
    expect(byName.fails?.failureStack).toBe("stack trace here");
    expect(byName.errors?.status).toBe("error");
    expect(byName.errors?.failureMessage).toBe("boom");
    expect(byName.skipped?.status).toBe("skipped");
  });

  it("flattens nested testsuites (testsuites wrapper with multiple testsuite children)", () => {
    const xml = `
      <testsuites>
        <testsuite name="SuiteA">
          <testcase classname="pkg.A" name="testA" />
        </testsuite>
        <testsuite name="SuiteB">
          <testcase classname="pkg.B" name="testB" />
        </testsuite>
      </testsuites>
    `;

    const suites = parseJunitXml(xml);
    expect(suites.map((s) => s.suiteName)).toEqual(["SuiteA", "SuiteB"]);
  });

  it("flattens testsuite nested inside another testsuite", () => {
    const xml = `
      <testsuite name="Outer">
        <testsuite name="Inner">
          <testcase classname="pkg.C" name="testC" />
        </testsuite>
      </testsuite>
    `;

    const suites = parseJunitXml(xml);
    expect(suites.map((s) => s.suiteName)).toEqual(["Outer", "Inner"]);
    expect(suites[1]?.testCases[0]?.name).toBe("testC");
  });

  it("treats parameterized test names as distinct test cases", () => {
    const xml = `
      <testsuite name="Suite1">
        <testcase classname="pkg.Foo" name="test[param1]" />
        <testcase classname="pkg.Foo" name="test[param2]" />
      </testsuite>
    `;

    const suites = parseJunitXml(xml);
    expect(suites[0]?.testCases.map((tc) => tc.name)).toEqual(["test[param1]", "test[param2]"]);
  });

  it("preserves duplicate classname+name entries within one suite (reruns) without collapsing them", () => {
    const xml = `
      <testsuite name="Suite1">
        <testcase classname="pkg.Foo" name="flaky" time="0.01">
          <failure message="first attempt failed">stack</failure>
        </testcase>
        <testcase classname="pkg.Foo" name="flaky" time="0.02" />
      </testsuite>
    `;

    const suites = parseJunitXml(xml);
    expect(suites[0]?.testCases).toHaveLength(2);
    expect(suites[0]?.testCases[0]?.status).toBe("failed");
    expect(suites[0]?.testCases[1]?.status).toBe("passed");
  });

  describe("suite-level count attributes", () => {
    it("reads tests, failures, errors, skipped and time as numbers", () => {
      const xml = `
        <testsuite name="Suite1" tests="3" failures="1" errors="0" skipped="2" time="1.5">
          <testcase classname="pkg.Foo" name="a" />
        </testsuite>
      `;
      expect(parseJunitXml(xml)[0]).toMatchObject({ tests: 3, failures: 1, errors: 0, skipped: 2, timeSeconds: 1.5 });
    });

    it("reads a skipped attribute of zero as 0, not as missing", () => {
      const xml = `<testsuite name="S" tests="1" failures="0" errors="0" skipped="0"><testcase classname="c" name="a"/></testsuite>`;
      expect(parseJunitXml(xml)[0]?.skipped).toBe(0);
    });

    it("keeps each nested suite's own counts", () => {
      const xml = `
        <testsuites>
          <testsuite name="A" tests="2" failures="0" errors="0" skipped="1">
            <testcase classname="c" name="x" />
            <testcase classname="c" name="y"><skipped /></testcase>
          </testsuite>
          <testsuite name="B" tests="1" failures="1" errors="0" skipped="0">
            <testcase classname="c" name="z"><failure message="m" /></testcase>
          </testsuite>
        </testsuites>
      `;
      const [a, b] = parseJunitXml(xml);
      expect(a).toMatchObject({ suiteName: "A", tests: 2, failures: 0, skipped: 1 });
      expect(b).toMatchObject({ suiteName: "B", tests: 1, failures: 1, skipped: 0 });
    });

    it("leaves a count undefined when the attribute is absent", () => {
      const suite = parseJunitXml(`<testsuite name="S"><testcase classname="c" name="a"/></testsuite>`)[0];
      expect(suite?.skipped).toBeUndefined();
      expect(suite?.failures).toBeUndefined();
    });

    it("still reports a <skipped/> element as a skipped testcase when the suite also has a skipped attribute", () => {
      const xml = `
        <testsuite name="S" tests="2" skipped="1">
          <testcase classname="c" name="plain" />
          <testcase classname="c" name="ignored"><skipped message="not today" /></testcase>
        </testsuite>
      `;
      const [suite] = parseJunitXml(xml);
      expect(suite?.skipped).toBe(1);
      expect(suite?.testCases.map((t) => [t.name, t.status])).toEqual([
        ["plain", "passed"],
        ["ignored", "skipped"],
      ]);
    });
  });
});
