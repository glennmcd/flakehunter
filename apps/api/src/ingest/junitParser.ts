import type { TestResultStatus } from "@flakehunter/shared-types";
import { XMLParser } from "fast-xml-parser";

export interface ParsedTestCase {
  classname: string;
  name: string;
  status: TestResultStatus;
  durationSeconds?: number;
  failureMessage?: string;
  failureStack?: string;
}

export interface ParsedSuite {
  suiteName: string;
  fileName?: string;
  tests?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  timeSeconds?: number;
  testCases: ParsedTestCase[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
  // The callback is also called for attributes. A suite's `skipped="2"` count shares its name with the <skipped>
  // element, so without the isAttribute check it would be wrapped in an array and read back as undefined.
  isArray: (tagName, _jPath, _isLeafNode, isAttribute) =>
    !isAttribute && ["testsuite", "testcase", "failure", "error", "skipped"].includes(tagName),
});

interface RawNode {
  [key: string]: unknown;
}

function collectSuiteNodes(node: unknown, acc: RawNode[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as RawNode;

  if (Array.isArray(obj.testsuite)) {
    for (const child of obj.testsuite as RawNode[]) {
      acc.push(child);
      collectSuiteNodes(child, acc);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "testsuite" || key === "testcase") continue;
    if (Array.isArray(value)) {
      for (const item of value) collectSuiteNodes(item, acc);
    } else if (value && typeof value === "object") {
      collectSuiteNodes(value, acc);
    }
  }
}

function presentElement(value: unknown[] | undefined): RawNode | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return typeof first === "object" && first !== null ? (first as RawNode) : {};
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseTestCase(node: RawNode): ParsedTestCase {
  const classname = String(node.classname ?? "");
  const name = String(node.name ?? "");
  const durationSeconds = toNumber(node.time);

  const skipped = presentElement(node.skipped as unknown[] | undefined);
  const error = presentElement(node.error as unknown[] | undefined);
  const failure = presentElement(node.failure as unknown[] | undefined);

  let status: TestResultStatus = "passed";
  let failureMessage: string | undefined;
  let failureStack: string | undefined;

  if (skipped) {
    status = "skipped";
  } else if (error) {
    status = "error";
    failureMessage = typeof error.message === "string" ? error.message : undefined;
    failureStack = typeof error["#text"] === "string" ? (error["#text"] as string) : undefined;
  } else if (failure) {
    status = "failed";
    failureMessage = typeof failure.message === "string" ? failure.message : undefined;
    failureStack = typeof failure["#text"] === "string" ? (failure["#text"] as string) : undefined;
  }

  return { classname, name, status, durationSeconds, failureMessage, failureStack };
}

export function parseJunitXml(xml: string, fileName?: string): ParsedSuite[] {
  const parsed = parser.parse(xml) as RawNode;
  const suiteNodes: RawNode[] = [];
  collectSuiteNodes(parsed, suiteNodes);

  return suiteNodes.map((suiteNode) => {
    const testCases = Array.isArray(suiteNode.testcase) ? (suiteNode.testcase as RawNode[]).map(parseTestCase) : [];

    return {
      suiteName: String(suiteNode.name ?? ""),
      fileName,
      tests: toNumber(suiteNode.tests),
      failures: toNumber(suiteNode.failures),
      errors: toNumber(suiteNode.errors),
      skipped: toNumber(suiteNode.skipped),
      timeSeconds: toNumber(suiteNode.time),
      testCases,
    };
  });
}
