import type { GateDecision } from "./basicAuth";

export type LoginOutcome = "success" | "failure";

/** Longest value copied into a log line; header values come from the client and can be as long as they like. */
const MAX_FIELD_LENGTH = 200;

/** Collapses control characters and trims, so a client cannot break a log line, and cuts the value short. */
function clean(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\p{Cc}/gu, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
}

/**
 * Whether a request is someone opening a page, as opposed to a file or a background fetch the page made. Next removes
 * its own markers (the RSC and prefetch headers and the `_rsc` parameter) before `proxy.ts` runs, so they cannot be
 * used; what a browser always adds is `Sec-Fetch-Dest`: `document` for opening a page, anything else (`empty` for the
 * fetches Next uses to prefetch and navigate, `script`, `style`, `image`, ...) for requests a page made. Without the
 * header (curl, a script, or a proxy that dropped it) the request is counted as a page, so a success is never missed.
 */
function isPageRequest(pathname: string, headers: Headers): boolean {
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return false;
  const dest = headers.get("sec-fetch-dest");
  return dest === null || dest.trim().toLowerCase() === "document";
}

/**
 * Whether this request is a login worth a log line, and which kind. The site has no login form: the browser sends the
 * password in an Authorization header on every request. So:
 * - a **failure** is any request that sent credentials the gate refused, whatever it was for;
 * - a **success** is a request that sent accepted credentials for a page (not an asset or a background fetch; see
 *   isPageRequest), so each page load logs once instead of once per file and prefetch;
 * - a request with no credentials is the browser's first request, which the gate answers with the password prompt, and
 *   a gate that is open (development) has no login: neither is logged.
 */
export function loginOutcome(input: {
  decision: GateDecision;
  headers: Headers;
  pathname: string;
  sitePassword: string | undefined;
}): LoginOutcome | null {
  const presented = input.headers.has("authorization");
  if (!input.decision.allow) return input.decision.status === 401 && presented ? "failure" : null;
  if (!presented || !input.sitePassword) return null;
  return isPageRequest(input.pathname, input.headers) ? "success" : null;
}

/**
 * One JSON line describing who tried to log in. It never contains the Authorization header, the password or the
 * username (a mistyped password can end up in the username box), and it leaves out the query string.
 *
 * The address to trust is `viewerAddress` (CloudFront-Viewer-Address, which CloudFront sets itself and Amplify passes
 * on). `forwardedFor` is logged as received because a client can start the x-forwarded-for chain with any address,
 * and it ends with an AWS hop, so neither its first nor its last entry is the client.
 */
export function loginLogLine(outcome: LoginOutcome, request: { method: string; pathname: string; headers: Headers }) {
  const { headers } = request;
  return JSON.stringify({
    event: "site_login",
    outcome,
    method: request.method,
    path: clean(request.pathname),
    forwardedFor: clean(headers.get("x-forwarded-for")),
    viewerAddress: clean(headers.get("cloudfront-viewer-address")),
    country: clean(headers.get("cloudfront-viewer-country")),
    userAgent: clean(headers.get("user-agent")),
    // What the browser says the request is for ("document" for a page); absent when the client sends no such header.
    fetchDest: clean(headers.get("sec-fetch-dest")),
  });
}

/** Writes the line to the process output, which Amplify's server-side rendering sends to CloudWatch Logs. */
export function logLogin(outcome: LoginOutcome, request: { method: string; pathname: string; headers: Headers }) {
  const write = outcome === "success" ? console.log : console.warn;
  write(loginLogLine(outcome, request));
}
