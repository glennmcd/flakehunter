export type Outcome = "passed" | "failed" | "error" | "skipped";

export interface JunitCase {
  classname: string;
  name: string;
  timeSeconds: number;
  outcome: Outcome;
  /** Failure or error message (the `message` attribute). */
  message?: string;
  /** Exception class (the `type` attribute). */
  type?: string;
  /** Stack trace (the element body). */
  stack?: string;
}

export interface JunitSuite {
  name: string;
  cases: JunitCase[];
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderCase(c: JunitCase): string {
  const open = `<testcase classname="${escapeXml(c.classname)}" name="${escapeXml(c.name)}" time="${c.timeSeconds.toFixed(3)}"`;
  if (c.outcome === "passed") return `${open}/>`;
  if (c.outcome === "skipped") return `${open}><skipped/></testcase>`;

  const tag = c.outcome === "failed" ? "failure" : "error";
  const attrs = [
    c.message === undefined ? "" : ` message="${escapeXml(c.message)}"`,
    c.type === undefined ? "" : ` type="${escapeXml(c.type)}"`,
  ].join("");
  const body = c.stack === undefined ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${escapeXml(c.stack)}</${tag}>`;
  return `${open}>${body}</testcase>`;
}

function renderSuite(suite: JunitSuite): string {
  const count = (outcome: Outcome) => suite.cases.filter((c) => c.outcome === outcome).length;
  const time = suite.cases.reduce((sum, c) => sum + c.timeSeconds, 0);
  const attrs =
    `name="${escapeXml(suite.name)}" tests="${suite.cases.length}" failures="${count("failed")}" ` +
    `errors="${count("error")}" skipped="${count("skipped")}" time="${time.toFixed(3)}"`;
  if (suite.cases.length === 0) return `  <testsuite ${attrs}/>`;
  return [`  <testsuite ${attrs}>`, ...suite.cases.map((c) => `    ${renderCase(c)}`), "  </testsuite>"].join("\n");
}

/** Builds a JUnit XML document (`<testsuites>` wrapping one `<testsuite>` per suite) in the shape CI tools emit. */
export function buildJunitXml(suites: JunitSuite[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.map(renderSuite).join("\n")}\n</testsuites>\n`;
}
