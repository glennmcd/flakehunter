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

  describe("entities and DOCTYPE", () => {
    it("decodes more than 1000 standard escapes, as long stack traces have", () => {
      const stack = "expected a &lt; b &amp;&amp; c &gt; d &quot;e&apos;\n".repeat(300);
      const xml = `<testsuite name="S"><testcase classname="c" name="t"><failure message="&lt;boom&gt;">${stack}</failure></testcase></testsuite>`;

      const testCase = parseJunitXml(xml)[0]?.testCases[0];
      expect(testCase?.failureMessage).toBe("<boom>");
      expect(testCase?.failureStack).toBe(`expected a < b && c > d "e'\n`.repeat(300).trim());
    });

    // The parser reads a DOCTYPE wherever one appears outside CDATA, comments and processing instructions, and applies
    // its entities to everything after it, so each placement is tried.
    const doctype = (entities: string) => `<!DOCTYPE a [${entities}]>`;
    const placements = (entities: string) => ({
      "before the root": `${doctype(entities)}<testsuite name="S"><testcase classname="c" name="&e;" /></testsuite>`,
      "inside the root": `<testsuites>${doctype(entities)}<testsuite name="S"><testcase classname="c" name="&e;" /></testsuite></testsuites>`,
      "after stray text": `x${doctype(entities)}<testsuite name="S"><testcase classname="c" name="&e;" /></testsuite>`,
    });

    it("refuses an entity longer than one character, wherever the DOCTYPE is", () => {
      for (const [where, xml] of Object.entries(placements(`<!ENTITY e "${"A".repeat(1000)}">`))) {
        expect(() => parseJunitXml(xml), where).toThrow(/exceeds maximum allowed/);
      }
    });

    it("refuses a second entity, wherever the DOCTYPE is", () => {
      for (const [where, xml] of Object.entries(placements(`<!ENTITY e "x"><!ENTITY f "y">`))) {
        expect(() => parseJunitXml(xml), where).toThrow(/exceeds maximum allowed/);
      }
    });

    it("refuses the classic billion laughs declaration", () => {
      const billionLaughs = `<?xml version="1.0"?>
        <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
        <testsuite name="S"><testcase classname="c" name="&lol2;" /></testsuite>`;
      expect(() => parseJunitXml(billionLaughs)).toThrow(/exceeds maximum allowed/);
    });

    it("lets through at most one one-character entity, which can only shorten text", () => {
      for (const [where, xml] of Object.entries(placements(`<!ENTITY e "$">`))) {
        expect(parseJunitXml(xml)[0]?.testCases[0]?.name, where).toBe("$");
      }
    });

    it("parses captured HTML or XML inside CDATA as text, even after an XML declaration", () => {
      const captured = `got <?xml version="1.0"?>\n<!DOCTYPE html><html></html>`;
      for (const prolog of ["", `<?xml version="1.0"?>\n<!-- generated -->\n`]) {
        const xml = `${prolog}<testsuite name="S"><testcase classname="c" name="t"><failure message="m"><![CDATA[${captured}]]></failure></testcase></testsuite>`;
        expect(parseJunitXml(xml)[0]?.testCases[0]?.failureStack).toBe(captured);
      }
    });

    it("parses many processing instructions and comments before the root in linear time", () => {
      const start = performance.now();
      const suites = parseJunitXml(`${"<?a?><!---->".repeat(50)}<testsuite name="S" />`);
      expect(suites[0]?.suiteName).toBe("S");
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});
