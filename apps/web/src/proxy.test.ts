import { afterEach, describe, expect, it } from "bun:test";
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

function request(url = "http://localhost:3000/", credentials?: string) {
  const headers = new Headers();
  if (credentials !== undefined) headers.set("authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
  return new NextRequest(url, { headers });
}

describe("proxy (site password gate)", () => {
  it("lets a request with the right password through", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    const response = await proxy(request("http://localhost:3000/repos/3", "demo:hunter2"));
    expect(response.status).toBe(200);
    // NextResponse.next() marks a pass-through.
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("challenges a missing or wrong password with 401 and a Basic realm", async () => {
    configure({ SITE_PASSWORD: "hunter2", NODE_ENV: "production" });
    for (const req of [request(), request("http://localhost:3000/", "demo:wrong")]) {
      const response = await proxy(req);
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
    const response = await proxy(request("http://localhost:3000/", "demo:wrong"));
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain("hunter2");
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
