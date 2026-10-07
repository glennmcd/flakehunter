import { type NextRequest, NextResponse } from "next/server";
import { loginOutcome, logLogin } from "./lib/accessLog";
import { gateDecision } from "./lib/basicAuth";

// Site-wide password gate (Next 16's `proxy`, formerly `middleware`). With no `config.matcher` it runs on every
// request, framework assets included: after the browser's one-time prompt it sends the credentials with every
// same-origin request, so nothing needs to be exempt, and nothing can be forgotten. Runs on the Node.js runtime.
// Reads the environment directly instead of loadEnv(), so a missing API variable cannot take the gate down with it.
export function proxy(request: NextRequest) {
  const decision = gateDecision({
    authorization: request.headers.get("authorization"),
    sitePassword: process.env.SITE_PASSWORD,
    nodeEnv: process.env.NODE_ENV,
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

  if (decision.status === 401) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="FlakeHunter", charset="UTF-8"', "cache-control": "no-store" },
    });
  }

  return new Response("The site password is not configured, so this site is not being served.", {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}
