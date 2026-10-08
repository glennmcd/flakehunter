import { describe, expect, it } from "bun:test";
import { loginLogLine, loginOutcome } from "./accessLog";

const allow = { allow: true } as const;
const challenge = { allow: false, status: 401 } as const;
const notConfigured = { allow: false, status: 503 } as const;

function headers(values: Record<string, string> = {}) {
  return new Headers(values);
}

const withCredentials = headers({ authorization: "Basic ZGVtbzpodW50ZXIy" });

describe("loginOutcome", () => {
  it("is a failure when credentials were sent and refused, for any path", () => {
    for (const pathname of ["/", "/repos/3", "/_next/static/chunk.js", "/favicon.ico"]) {
      expect(loginOutcome({ decision: challenge, headers: withCredentials, pathname, sitePassword: "x" })).toBe(
        "failure",
      );
    }
  });

  it("is not logged when no credentials were sent: that is the browser's first request, answered with the prompt", () => {
    expect(loginOutcome({ decision: challenge, headers: headers(), pathname: "/", sitePassword: "x" })).toBeNull();
  });

  it("is a success when accepted credentials open a page", () => {
    expect(loginOutcome({ decision: allow, headers: withCredentials, pathname: "/repos/3", sitePassword: "x" })).toBe(
      "success",
    );
  });

  const success = (pathname: string, extra: Record<string, string> = {}) =>
    loginOutcome({
      decision: allow,
      headers: headers({ authorization: "Basic ZGVtbzpodW50ZXIy", ...extra }),
      pathname,
      sitePassword: "x",
    });

  it("does not log a success for framework assets or the favicon", () => {
    expect(success("/_next/static/chunk.js", { "sec-fetch-dest": "document" })).toBeNull();
    expect(success("/favicon.ico")).toBeNull();
  });

  it("logs a success only when the browser says it is opening a page, not fetching something for one", () => {
    expect(success("/repos/3", { "sec-fetch-dest": "document" })).toBe("success");
    expect(success("/repos/3", { "sec-fetch-dest": " Document " })).toBe("success");
    // Next's prefetches and client-side navigations are fetch() calls, which browsers label "empty".
    for (const dest of ["empty", "script", "style", "image", "font", "iframe", "frame", "worker"]) {
      expect(success("/repos/3", { "sec-fetch-dest": dest })).toBeNull();
    }
  });

  it("counts a request without fetch metadata (curl, a script, a proxy that drops it) as a page, so no success is missed", () => {
    expect(success("/repos/3")).toBe("success");
  });

  it("does not rely on Next's RSC or prefetch headers, which Next removes before proxy.ts runs", () => {
    // In production the proxy never sees these; if it did, they must not hide a page load that the browser labels a document.
    expect(success("/repos/3", { rsc: "1", "next-router-prefetch": "1", "sec-fetch-dest": "document" })).toBe(
      "success",
    );
  });

  it("has no login when the gate is open (no password set), even if a client sends an Authorization header", () => {
    expect(
      loginOutcome({ decision: allow, headers: withCredentials, pathname: "/", sitePassword: undefined }),
    ).toBeNull();
  });

  it("does not call a 'not configured' refusal a failed login", () => {
    expect(
      loginOutcome({ decision: notConfigured, headers: withCredentials, pathname: "/", sitePassword: undefined }),
    ).toBeNull();
  });
});

describe("loginLogLine", () => {
  const request = {
    method: "GET",
    pathname: "/repos/3",
    headers: headers({
      "x-forwarded-for": "203.0.113.9, 198.51.100.4",
      "cloudfront-viewer-address": "203.0.113.9:51234",
      "cloudfront-viewer-country": "US",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
      "sec-fetch-dest": "document",
      authorization: "Basic ZGVtbzpodW50ZXIy",
      cookie: "session=abc",
    }),
  };

  it("is one JSON object with the client's details", () => {
    const line = loginLogLine("failure", request);

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      event: "site_login",
      outcome: "failure",
      method: "GET",
      path: "/repos/3",
      forwardedFor: "203.0.113.9, 198.51.100.4",
      viewerAddress: "203.0.113.9:51234",
      country: "US",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      fetchDest: "document",
    });
  });

  it("never contains the credentials or other sensitive headers", () => {
    const line = loginLogLine("success", request);
    for (const secret of ["ZGVtbzpodW50ZXIy", "hunter2", "demo", "Basic", "session=abc"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("leaves out fields the request does not have", () => {
    const parsed = JSON.parse(loginLogLine("success", { method: "GET", pathname: "/", headers: headers() }));
    expect(Object.keys(parsed).sort()).toEqual(["event", "method", "outcome", "path"]);
  });

  it("replaces control characters and cuts a long header short", () => {
    // Headers refuses a newline in a value, so tab and \u0001 stand in for what a client can really send.
    const hostile = `curl/8\t\u0001{"outcome":"success"}${"A".repeat(1000)}`;
    const line = loginLogLine("failure", { method: "GET", pathname: "/", headers: headers({ "user-agent": hostile }) });

    const { userAgent, outcome } = JSON.parse(line) as { userAgent: string; outcome: string };
    expect(outcome).toBe("failure");
    expect(userAgent.startsWith('curl/8  {"outcome":"success"}')).toBe(true);
    expect(userAgent).not.toMatch(/\p{Cc}/u);
    expect(userAgent.length).toBeLessThanOrEqual(201);
    expect(userAgent.endsWith("…")).toBe(true);
  });
});
