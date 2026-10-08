import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

// Next's types declare process.env.NODE_ENV read-only; the tests need to vary it.
const env = process.env as Record<string, string | undefined>;
const saved = { SITE_PASSWORD: env.SITE_PASSWORD, NODE_ENV: env.NODE_ENV };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

function configure(settings: { SITE_PASSWORD?: string; NODE_ENV: string }) {
  if (settings.SITE_PASSWORD === undefined) delete env.SITE_PASSWORD;
  else env.SITE_PASSWORD = settings.SITE_PASSWORD;
  env.NODE_ENV = settings.NODE_ENV;
}

function request(url = "http://localhost:3000/", credentials?: string, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(extraHeaders);
  if (credentials !== undefined) headers.set("authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
  return new NextRequest(url, { headers });
}

/** Runs the proxy while capturing what it writes to the console, split into info and warning lines. */
async function withLogs(req: NextRequest) {
  const info = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await proxy(req);
    return { response, info: info.mock.calls.map((c) => String(c[0])), warn: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
}

describe("proxy (site password gate)", () => {
  it("lets a request with the right password through", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    const response = (await withLogs(request("http://localhost:3000/repos/3", "demo:hunter2"))).response;
    expect(response.status).toBe(200);
    // NextResponse.next() marks a pass-through.
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("challenges a missing or wrong password with 401 and a Basic realm", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    for (const req of [request(), request("http://localhost:3000/", "demo:wrong")]) {
      const response = (await withLogs(req)).response;
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="FlakeHunter", charset="UTF-8"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it("gates every path, including nested pages and framework assets", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    for (const path of ["/", "/repos/3", "/repos/3/tests/63", "/_next/static/chunk.js", "/favicon.ico"]) {
      expect((await proxy(request(`http://localhost:3000${path}`))).status).toBe(401);
    }
  });

  it("never reveals the password in a response", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    const response = (await withLogs(request("http://localhost:3000/", "demo:wrong"))).response;
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain("hunter2");
  });

  describe("login log", () => {
    const client = { "x-forwarded-for": "203.0.113.9", "user-agent": "test-agent/1.0" };

    it("logs a successful page login with the client's details", async () => {
      configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
      const { response, info, warn } = await withLogs(request("http://localhost:3000/repos/3", "demo:hunter2", client));

      expect(response.status).toBe(200);
      expect(warn).toEqual([]);
      expect(info).toHaveLength(1);
      expect(JSON.parse(info[0] ?? "")).toMatchObject({
        event: "site_login",
        outcome: "success",
        method: "GET",
        path: "/repos/3",
        forwardedFor: "203.0.113.9",
        userAgent: "test-agent/1.0",
      });
    });

    it("logs a failed login as a warning with the client's details, and never the password tried", async () => {
      configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
      const { response, info, warn } = await withLogs(request("http://localhost:3000/", "demo:guess-123", client));

      expect(response.status).toBe(401);
      expect(info).toEqual([]);
      expect(warn).toHaveLength(1);
      expect(JSON.parse(warn[0] ?? "")).toMatchObject({
        event: "site_login",
        outcome: "failure",
        forwardedFor: "203.0.113.9",
        userAgent: "test-agent/1.0",
      });
      for (const secret of ["guess-123", "hunter2", Buffer.from("demo:guess-123").toString("base64")]) {
        expect(warn[0]).not.toContain(secret);
      }
    });

    it("stays quiet for the browser's first request (the password prompt) and for assets", async () => {
      configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
      const prompt = await withLogs(request("http://localhost:3000/", undefined, client));
      const asset = await withLogs(request("http://localhost:3000/_next/static/chunk.js", "demo:hunter2", client));

      expect(prompt.response.status).toBe(401);
      expect(asset.response.status).toBe(200);
      for (const result of [prompt, asset]) {
        expect(result.info).toEqual([]);
        expect(result.warn).toEqual([]);
      }
    });

    it("stays quiet for a browser's background fetches (Next prefetches), but still logs a failed one", async () => {
      configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
      const background = { ...client, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };

      const ok = await withLogs(request("http://localhost:3000/repos/3", "demo:hunter2", background));
      expect(ok.response.status).toBe(200);
      expect(ok.info).toEqual([]);
      expect(ok.warn).toEqual([]);

      const bad = await withLogs(request("http://localhost:3000/repos/3", "demo:wrong", background));
      expect(bad.response.status).toBe(401);
      expect(bad.warn).toHaveLength(1);
      expect(JSON.parse(bad.warn[0] ?? "")).toMatchObject({ outcome: "failure", fetchDest: "empty" });
    });

    it("logs a page load once, with what the browser said it was for", async () => {
      configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
      const { info } = await withLogs(
        request("http://localhost:3000/repos/3", "demo:hunter2", { ...client, "sec-fetch-dest": "document" }),
      );
      expect(info).toHaveLength(1);
      expect(JSON.parse(info[0] ?? "")).toMatchObject({ outcome: "success", fetchDest: "document" });
    });

    it("logs nothing when the site is open in development", async () => {
      configure({ NODE_ENV: "development" });
      const { info, warn } = await withLogs(request("http://localhost:3000/", "demo:anything", client));
      expect(info).toEqual([]);
      expect(warn).toEqual([]);
    });
  });

  it("is open without a password in development", async () => {
    configure({ NODE_ENV: "development" });
    const response = await proxy(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("refuses to serve (503) without a password in production, whatever the request carries", async () => {
    configure({ NODE_ENV: "production" });
    for (const req of [request(), request("http://localhost:3000/", "demo:anything")]) {
      const response = await proxy(req);
      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("not configured");
    }
  });
});
