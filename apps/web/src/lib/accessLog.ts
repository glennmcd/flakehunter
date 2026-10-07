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

/** Framework assets and background fetches are not someone opening the site, so a success is not logged for them. */
function isPageRequest(pathname: string, headers: Headers): boolean {
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return false;
  return !headers.has("rsc") && !headers.has("next-router-prefetch");
}

/**
 * Whether this request is a login worth a log line, and which kind. The site has no login form: the browser sends the
 * password in an Authorization header on every request. So:
 * - a **failure** is any request that sent credentials the gate refused, whatever it was for;
 * - a **success** is a request that sent accepted credentials for a page (not an asset or a prefetch), so each page
 *   load logs once instead of once per file;
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
 * Behind CloudFront the real client address is in x-forwarded-for, but the client can write the start of that header
 * itself, so the whole chain is logged rather than picking one entry. CloudFront's own view of the viewer is logged
 * too when Amplify forwards it.
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
  });
}

/** Writes the line to the process output, which Amplify's server-side rendering sends to CloudWatch Logs. */
export function logLogin(outcome: LoginOutcome, request: { method: string; pathname: string; headers: Headers }) {
  const write = outcome === "success" ? console.log : console.warn;
  write(loginLogLine(outcome, request));
}
