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

    const byName = Object.fromEntries(suites[0]!.testCases.map((tc) => [tc.name, tc]));
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
});
