import { createHash } from "node:crypto";
import type { onRequestAsyncHookHandler } from "fastify";
import { ApiError } from "../api/errors.js";
import type { RateLimitHit, RateLimitStore } from "./store.js";

export interface RateLimitConfig {
  /** Requests allowed per key in one window. */
  max: number;
  windowSeconds: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { max: 120, windowSeconds: 60 };

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

/** Reads UPLOAD_RATE_LIMIT_MAX and UPLOAD_RATE_LIMIT_WINDOW_SECONDS; unset means the defaults. */
export function readRateLimitConfig(env: Record<string, string | undefined> = process.env): RateLimitConfig {
  return {
    max: positiveInt(env, "UPLOAD_RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max),
    windowSeconds: positiveInt(env, "UPLOAD_RATE_LIMIT_WINDOW_SECONDS", DEFAULT_RATE_LIMIT.windowSeconds),
  };
}

/**
 * The keys a request is counted under: always its source IP, plus a hash of its bearer token when it sends one (the
 * raw token is never stored). The IP key is what stops a flood of invented tokens, since each invented token would
 * otherwise start with a fresh budget; the token key stops one token being used from many addresses. Neither is
 * checked against the database.
 */
export function rateLimitKeys(authorization: string | undefined, ip: string): string[] {
  const keys = [`ip:${ip}`];
  const match = /^Bearer (.+)$/.exec(authorization ?? "");
  if (match?.[1]) keys.push(`token:${createHash("sha256").update(match[1]).digest("hex")}`);
  return keys;
}

/**
 * An onRequest hook that counts the request under each of its keys and answers 429 (`rate_limited`, with Retry-After)
 * once any key passes the limit. Put it before any hook that touches the database, so floods of bad tokens never
 * reach Postgres.
 *
 * If the store itself fails the request is let through and the failure is logged: a broken counter should not take
 * uploads down with it, and the other protections (token, size cap, concurrency limit) still apply.
 */
export function rateLimitHook(store: RateLimitStore, config: RateLimitConfig): onRequestAsyncHookHandler {
  return async (request, reply) => {
    const keys = rateLimitKeys(request.headers.authorization, request.ip);

    let hits: RateLimitHit[];
    try {
      hits = await Promise.all(keys.map((key) => store.hit(key, config.windowSeconds)));
    } catch (error) {
      request.log.warn({ err: error }, "rate limit store failed; letting the request through");
      return;
    }

    // Report on the key closest to (or furthest past) its limit.
    const worst = hits.reduce((a, b) => (b.count > a.count ? b : a));
    const secondsLeft = Math.max(1, Math.ceil(worst.resetAt - Date.now() / 1000));
    reply.header("ratelimit-limit", String(config.max));
    reply.header("ratelimit-remaining", String(Math.max(0, config.max - worst.count)));
    reply.header("ratelimit-reset", String(secondsLeft));

    if (worst.count > config.max) {
      reply.header("retry-after", String(secondsLeft));
      throw new ApiError("rate_limited", `Too many requests; retry in ${secondsLeft} seconds`);
    }
  };
}
