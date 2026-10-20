import { describe, expect, it } from "bun:test";
import { repoRefSchema, uploadReportHeadersSchema } from "./index";

describe("v2 repoRefSchema", () => {
  it("parses a numeric id, a path and a host-qualified path", () => {
    expect(repoRefSchema.parse("12")).toEqual({ id: 12 });
    expect(repoRefSchema.parse("acme/widgets")).toEqual({ fullName: "acme/widgets", host: undefined });
    expect(repoRefSchema.parse("group/sub/project")).toEqual({ fullName: "group/sub/project", host: undefined });
    expect(repoRefSchema.parse("github:acme/widgets")).toEqual({ fullName: "acme/widgets", host: "github" });
  });

  it("rejects an unknown host, a single segment and junk", () => {
    for (const bad of [
      "",
      "acme",
      "bitbucket:acme/widgets",
      "github:acme",
      ":acme/widgets",
      "a//b",
      "has space/x",
      "a/b/",
    ]) {
      expect(repoRefSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("v2 uploadReportHeadersSchema", () => {
  const base = { "x-fh-run-id": "987", "x-fh-sha": "a".repeat(40) };

  it("leaves x-fh-ci-source out when absent and accepts a known value", () => {
    expect(uploadReportHeadersSchema.parse(base)["x-fh-ci-source"]).toBeUndefined();
    expect(uploadReportHeadersSchema.parse({ ...base, "x-fh-ci-source": "github_actions" })["x-fh-ci-source"]).toBe(
      "github_actions",
    );
  });

  it("rejects an unknown CI source", () => {
    expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-ci-source": "jenkins" }).success).toBe(false);
  });
});
