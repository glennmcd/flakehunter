import { describe, expect, it } from "bun:test";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("reads both variables and trims trailing slashes", () => {
    expect(loadEnv({ API_BASE_URL: "http://localhost:3000//", API_TOKEN: "t" })).toEqual({
      apiBaseUrl: "http://localhost:3000",
      apiToken: "t",
    });
  });

  it("names every problem without echoing values", () => {
    expect(() => loadEnv({})).toThrow("API_TOKEN is required; API_BASE_URL is required");
    expect(() => loadEnv({ API_BASE_URL: "ftp://x", API_TOKEN: "super-secret" })).toThrow(
      "API_BASE_URL must be an http(s) URL",
    );
    try {
      loadEnv({ API_BASE_URL: "nope", API_TOKEN: "super-secret" });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
    }
  });
});
