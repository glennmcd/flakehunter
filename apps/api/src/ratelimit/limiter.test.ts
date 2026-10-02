import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import errorHandlerPlugin from "../plugins/errorHandler.js";
import { DEFAULT_RATE_LIMIT, rateLimitHook, rateLimitKeys, readRateLimitConfig } from "./limiter.js";
import { MemoryRateLimitStore, type RateLimitStore } from "./store.js";

async function appWith(store: RateLimitStore, max = 3, windowSeconds = 60) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.post("/up", { onRequest: [rateLimitHook(store, { max, windowSeconds })] }, async () => ({ ok: true }));
  app.get("/free", async () => ({ ok: true }));
  return app;
}

let nextIp = 1;
/** A fresh source address, so tests that are not about the IP limit do not share one. */
const freshIp = () => `198.51.100.${nextIp++}`;

const post = (app: Awaited<ReturnType<typeof appWith>>, headers: Record<string, string> = {}, ip = freshIp()) =>
  app.inject({ method: "POST", url: "/up", headers, remoteAddress: ip });

describe("rateLimitKeys", () => {
  it("always includes the IP, and a hash of the bearer token when there is one", () => {
    const [ip, token] = rateLimitKeys("Bearer fh_secret_value", "1.2.3.4");
    expect(ip).toBe("ip:1.2.3.4");
    expect(token).toMatch(/^token:[0-9a-f]{64}$/);
    expect(token).not.toContain("fh_secret_value");
    expect(rateLimitKeys("Bearer fh_secret_value", "9.9.9.9")[1]).toBe(token);
  });

  it("has only the IP without a bearer token", () => {
    expect(rateLimitKeys(undefined, "1.2.3.4")).toEqual(["ip:1.2.3.4"]);
    expect(rateLimitKeys("Basic abc", "1.2.3.4")).toEqual(["ip:1.2.3.4"]);
    expect(rateLimitKeys("Bearer ", "1.2.3.4")).toEqual(["ip:1.2.3.4"]);
  });
});

describe("readRateLimitConfig", () => {
  it("defaults, and reads both variables", () => {
    expect(readRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMIT);
    expect(readRateLimitConfig({ UPLOAD_RATE_LIMIT_MAX: "10", UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "30" })).toEqual({
      max: 10,
      windowSeconds: 30,
    });
  });

  it("rejects values that are not positive integers, naming the variable", () => {
    for (const bad of ["0", "-1", "1.5", "ten", "1e3"]) {
      expect(() => readRateLimitConfig({ UPLOAD_RATE_LIMIT_MAX: bad })).toThrow("UPLOAD_RATE_LIMIT_MAX");
    }
    expect(() => readRateLimitConfig({ UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "0" })).toThrow(
      "UPLOAD_RATE_LIMIT_WINDOW_SECONDS",
    );
  });
});

describe("rateLimitHook", () => {
  it("lets requests through up to the limit and reports the remaining count", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 3);
    const ip = freshIp();
    for (const remaining of ["2", "1", "0"]) {
      const res = await post(app, { authorization: "Bearer t1" }, ip);
      expect(res.statusCode).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("3");
      expect(res.headers["ratelimit-remaining"]).toBe(remaining);
    }
  });

  it("answers 429 in the standard error body, with Retry-After, past the limit", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 2, 60);
    const ip = freshIp();
    await post(app, { authorization: "Bearer t1" }, ip);
    await post(app, { authorization: "Bearer t1" }, ip);
    const res = await post(app, { authorization: "Bearer t1" }, ip);

    expect(res.statusCode).toBe(429);
    expect(res.json<unknown>()).toMatchObject({ error: { code: "rate_limited" }, requestId: expect.any(String) });
    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.headers["ratelimit-remaining"]).toBe("0");
  });

  it("counts each token on its own when they come from different addresses", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 1);
    expect((await post(app, { authorization: "Bearer t1" })).statusCode).toBe(200);
    expect((await post(app, { authorization: "Bearer t2" })).statusCode).toBe(200);
  });

  it("limits one token used from many addresses", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 2);
    expect((await post(app, { authorization: "Bearer t1" })).statusCode).toBe(200);
    expect((await post(app, { authorization: "Bearer t1" })).statusCode).toBe(200);
    expect((await post(app, { authorization: "Bearer t1" })).statusCode).toBe(429);
  });

  it("limits one address that keeps inventing tokens, which a per-token limit alone would not catch", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 3);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(app, { authorization: `Bearer guess-${i}` }, ip)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("counts requests without a token by source IP", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 1);
    expect((await post(app, {}, "203.0.113.1")).statusCode).toBe(200);
    expect((await post(app, {}, "203.0.113.1")).statusCode).toBe(429);
    expect((await post(app, {}, "203.0.113.2")).statusCode).toBe(200);
  });

  it("never gives the store the raw token", async () => {
    const seen: string[] = [];
    const store: RateLimitStore = {
      hit: async (key) => {
        seen.push(key);
        return { count: 1, resetAt: Date.now() / 1000 + 60 };
      },
    };
    await post(await appWith(store), { authorization: "Bearer fh_very_secret" });
    expect(seen).toHaveLength(2);
    for (const key of seen) expect(key).not.toContain("fh_very_secret");
  });

  it("does not touch routes it is not attached to", async () => {
    const app = await appWith(new MemoryRateLimitStore(), 1);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/free" })).statusCode).toBe(200);
  });

  it("lets the request through when the store fails, instead of failing uploads", async () => {
    const store: RateLimitStore = {
      hit: async () => {
        throw new Error("dynamodb down");
      },
    };
    const app = await appWith(store, 1);
    const ip = freshIp();
    expect((await post(app, { authorization: "Bearer t1" }, ip)).statusCode).toBe(200);
    expect((await post(app, { authorization: "Bearer t1" }, ip)).statusCode).toBe(200);
  });
});
