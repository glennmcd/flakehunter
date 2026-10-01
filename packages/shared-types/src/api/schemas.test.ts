import { describe, expect, it } from "bun:test";
import { paginationQuerySchema } from "./common.js";
import { uploadReportHeadersSchema } from "./reports.js";
import { flakyTestsQuerySchema, repoRefSchema } from "./tests.js";

describe("repoRefSchema", () => {
  it("parses a numeric id", () => {
    expect(repoRefSchema.parse("12")).toEqual({ id: 12 });
  });

  it("parses owner/name", () => {
    expect(repoRefSchema.parse("acme/widgets")).toEqual({ fullName: "acme/widgets" });
  });

  it("rejects junk", () => {
    for (const bad of ["", "acme", "a/b/c", "has space/x", "12abc"]) {
      expect(repoRefSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("uploadReportHeadersSchema", () => {
  const base = { "x-fh-run-id": "987", "x-fh-sha": "a".repeat(40) };

  it("applies defaults and coerces numbers", () => {
    const parsed = uploadReportHeadersSchema.parse(base);
    expect(parsed["x-fh-run-id"]).toBe(987);
    expect(parsed["x-fh-run-attempt"]).toBe(1);
    expect(parsed["x-fh-workflow"]).toBe("upload");
    expect(parsed["x-fh-report-key"]).toBe("default");
    expect(parsed["x-fh-branch"]).toBeUndefined();
  });

  it("rejects a malformed sha, a missing run id and a non-positive attempt", () => {
    expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-sha": "abc123" }).success).toBe(false);
    expect(uploadReportHeadersSchema.safeParse({ "x-fh-sha": "a".repeat(40) }).success).toBe(false);
    expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-run-attempt": "0" }).success).toBe(false);
  });

  describe("x-fh-timestamp", () => {
    const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

    it("is optional", () => {
      expect(uploadReportHeadersSchema.parse(base)["x-fh-timestamp"]).toBeUndefined();
    });

    it("accepts a past ISO-8601 timestamp, with Z or an offset", () => {
      for (const ts of ["2026-01-15T10:30:00Z", "2026-01-15T10:30:00.123Z", "2026-01-15T10:30:00+02:00"]) {
        expect(uploadReportHeadersSchema.parse({ ...base, "x-fh-timestamp": ts })["x-fh-timestamp"]).toBe(ts);
      }
    });

    it("accepts a timestamp up to 5 minutes ahead (clock skew) but not further", () => {
      expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-timestamp": minutesFromNow(4) }).success).toBe(true);
      expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-timestamp": minutesFromNow(6) }).success).toBe(false);
      expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-timestamp": "2999-01-01T00:00:00Z" }).success).toBe(
        false,
      );
    });

    it("rejects malformed values", () => {
      for (const ts of ["yesterday", "2026-01-15", "2026-01-15 10:30:00", "1700000000", ""]) {
        expect(uploadReportHeadersSchema.safeParse({ ...base, "x-fh-timestamp": ts }).success).toBe(false);
      }
    });
  });
});

describe("paginationQuerySchema", () => {
  it("defaults to limit 50 offset 0", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it("coerces query strings and enforces bounds", () => {
    expect(paginationQuerySchema.parse({ limit: "200", offset: "10" })).toEqual({ limit: 200, offset: 10 });
    expect(paginationQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});

describe("flakyTestsQuerySchema", () => {
  it("requires repo, defaults minRuns to 5, and accepts an ISO since", () => {
    expect(flakyTestsQuerySchema.safeParse({}).success).toBe(false);
    const parsed = flakyTestsQuerySchema.parse({ repo: "3", since: "2026-01-01T00:00:00Z" });
    expect(parsed.minRuns).toBe(5);
    expect(parsed.repo).toEqual({ id: 3 });
  });

  it("rejects a non-ISO since", () => {
    expect(flakyTestsQuerySchema.safeParse({ repo: "3", since: "yesterday" }).success).toBe(false);
  });
});
