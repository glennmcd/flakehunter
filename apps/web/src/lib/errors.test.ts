import { describe, expect, it } from "bun:test";
import { ApiClientError } from "./api";
import { EnvError } from "./env";
import { describeError, isNotFound } from "./errors";

describe("describeError", () => {
  it("says what is wrong for each API failure, with the request id", () => {
    expect(describeError(new ApiClientError("network", "x", 0)).title).toBe("Cannot reach the API");
    const unauthorized = describeError(new ApiClientError("unauthorized", "x", 401, "req-1"));
    expect(unauthorized.title).toContain("rejected");
    expect(unauthorized.requestId).toBe("req-1");
    expect(describeError(new ApiClientError("invalid_response", "x", 200)).title).toContain("Unexpected");
    expect(describeError(new ApiClientError("internal_error", "x", 500, "req-2")).requestId).toBe("req-2");
  });

  it("never shows the raw error message", () => {
    const view = describeError(
      new ApiClientError("network", "Could not reach the API at http://secret.internal:3000", 0),
    );
    expect(JSON.stringify(view)).not.toContain("secret.internal");
  });

  it("handles a missing configuration and unknown errors", () => {
    expect(describeError(new EnvError([{ variable: "API_TOKEN", message: "is required" }])).title).toContain(
      "not configured",
    );
    expect(describeError(new Error("boom with token abc")).message).not.toContain("abc");
  });
});

describe("isNotFound", () => {
  it("is true only for the API's not_found", () => {
    expect(isNotFound(new ApiClientError("not_found", "x", 404))).toBe(true);
    expect(isNotFound(new ApiClientError("unauthorized", "x", 401))).toBe(false);
    expect(isNotFound(new Error("x"))).toBe(false);
  });
});
