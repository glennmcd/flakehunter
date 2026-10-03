import { describe, expect, it } from "bun:test";
import { ApiClientError, createApiClient } from "./apiClient";

const item = {
  testId: 1,
  classname: "pkg.Foo",
  name: "a test",
  shasRun: 10,
  flakyShas: 2,
  flakeRate: 0.2,
  lastFlakyAt: "2026-01-01T00:00:00.000Z",
};
const page = { limit: 20, offset: 0, total: 1 };

function clientWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, client: createApiClient({ apiBaseUrl: "http://api.test/", apiToken: "tok", fetch: fetchFn }) };
}

describe("getFlakyTests", () => {
  it("sends the bearer token and only the params it was given", async () => {
    const { calls, client } = clientWith(() => Response.json({ data: [item], page }));

    const result = await client.getFlakyTests({ repo: "acme/widgets", minRuns: 3 });

    expect(result.data).toEqual([item]);
    const call = calls[0];
    if (!call) throw new Error("no request was made");
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe("http://api.test/api/tests/flaky");
    expect(Object.fromEntries(url.searchParams)).toEqual({ repo: "acme/widgets", minRuns: "3" });
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("surfaces the API's error code and status", async () => {
    const body = { error: { code: "not_found", message: "Repo not found" }, requestId: "r1" };
    const { client } = clientWith(() => Response.json(body, { status: 404 }));

    const error = await client.getFlakyTests({ repo: "x/y" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: "not_found", status: 404, message: "Repo not found" });
  });

  it("reports a non-standard error body as unknown", async () => {
    const { client } = clientWith(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await client.getFlakyTests({ repo: "x/y" }).catch((e) => e)).toMatchObject({ code: "unknown", status: 502 });
  });

  it("reports a body that does not match the schema as invalid_response", async () => {
    const { client } = clientWith(() => Response.json({ data: [{ nope: true }], page }));
    expect(await client.getFlakyTests({ repo: "x/y" }).catch((e) => e)).toMatchObject({ code: "invalid_response" });
  });

  it("hides the underlying error when the network fails", async () => {
    const { client } = clientWith(() => {
      throw new Error("connect ECONNREFUSED with authorization: Bearer tok");
    });
    const error = await client.getFlakyTests({ repo: "x/y" }).catch((e) => e);
    expect(error).toMatchObject({ code: "network", status: 0 });
    expect(error.message).not.toContain("tok");
  });
});
