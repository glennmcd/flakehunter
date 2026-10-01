import { describe, expect, it } from "bun:test";
import { EnvError, loadEnv } from "./env";

const valid = { API_BASE_URL: "http://localhost:3000", API_TOKEN: "super-secret-token" };

function failure(source: Record<string, string | undefined>): EnvError {
  try {
    loadEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return err as EnvError;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("returns typed config for a valid environment", () => {
    expect(loadEnv({ ...valid, SITE_PASSWORD: "hunter2" })).toEqual({
      apiBaseUrl: "http://localhost:3000",
      apiToken: "super-secret-token",
      sitePassword: "hunter2",
    });
  });

  it("treats SITE_PASSWORD as optional, and an empty one as unset", () => {
    expect(loadEnv(valid).sitePassword).toBeUndefined();
    expect(loadEnv({ ...valid, SITE_PASSWORD: "" }).sitePassword).toBeUndefined();
  });

  it("trims trailing slashes from the API URL and accepts https and a path prefix", () => {
    expect(loadEnv({ ...valid, API_BASE_URL: "http://localhost:3000///" }).apiBaseUrl).toBe("http://localhost:3000");
    expect(loadEnv({ ...valid, API_BASE_URL: "https://flakehunter.fly.dev" }).apiBaseUrl).toBe(
      "https://flakehunter.fly.dev",
    );
    expect(loadEnv({ ...valid, API_BASE_URL: "https://example.com/proxy/" }).apiBaseUrl).toBe(
      "https://example.com/proxy",
    );
  });

  it("reports every missing required variable by name", () => {
    const err = failure({});
    expect(err.problems.map((p) => p.variable).sort()).toEqual(["API_BASE_URL", "API_TOKEN"]);
    expect(err.message).toContain("API_BASE_URL");
    expect(err.message).toContain("API_TOKEN");
  });

  it("treats empty required variables as missing", () => {
    expect(
      failure({ API_BASE_URL: "", API_TOKEN: "" })
        .problems.map((p) => p.variable)
        .sort(),
    ).toEqual(["API_BASE_URL", "API_TOKEN"]);
  });

  it("rejects an API URL that is not http(s)", () => {
    for (const bad of ["localhost:3000", "ftp://example.com", "not a url", "//example.com"]) {
      const err = failure({ ...valid, API_BASE_URL: bad });
      expect(err.problems).toEqual([{ variable: "API_BASE_URL", message: "must be an http(s) URL" }]);
    }
  });

  it("never puts secret values or the rejected URL into the error message", () => {
    const err = failure({ API_BASE_URL: "definitely not a url", API_TOKEN: "", SITE_PASSWORD: "hunter2" });
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("definitely not a url");

    const tokenErr = failure({ API_BASE_URL: "nope", API_TOKEN: "super-secret-token", SITE_PASSWORD: "hunter2" });
    expect(tokenErr.message).not.toContain("super-secret-token");
    expect(tokenErr.message).not.toContain("hunter2");
  });
});
