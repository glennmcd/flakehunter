import { type NextRequest, NextResponse } from "next/server";
import { loginOutcome, logLogin } from "./lib/accessLog";
import { gateDecision } from "./lib/basicAuth";

// Optional site-wide password gate (Next 16's `proxy`, formerly `middleware`), on only when SITE_PASSWORD is set.
// With no `config.matcher` it runs on every request, framework assets included: after the browser's one-time prompt
// it sends the credentials with every same-origin request, so nothing needs to be exempt, and nothing can be
// forgotten. Runs on the Node.js runtime. Reads the environment directly instead of loadEnv(), so a missing API
// variable cannot take the gate down with it.
export function proxy(request: NextRequest) {
  const decision = gateDecision({
    authorization: request.headers.get("authorization"),
    sitePassword: process.env.SITE_PASSWORD,
  });

  const outcome = loginOutcome({
    decision,
    headers: request.headers,
    pathname: request.nextUrl.pathname,
    sitePassword: process.env.SITE_PASSWORD,
  });
  if (outcome)
    logLogin(outcome, { method: request.method, pathname: request.nextUrl.pathname, headers: request.headers });

  if (decision.allow) return NextResponse.next();

  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="FlakeHunter", charset="UTF-8"', "cache-control": "no-store" },
  });
}
