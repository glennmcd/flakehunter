import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ApiClientError, apiClientFromEnv, createApiClient } from "./api";
import { EnvError } from "./env";

const TOKEN = "super-secret-token";
const BASE = "http://localhost:3000";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const page = { limit: 50, offset: 0, total: 1 };
const repos = {
  data: [{ id: 3, fullName: "flakehunter-demo/storefront", owner: "flakehunter-demo", name: "storefront" }],
  page,
};
const summary = {
  repo: { id: 3, fullName: "flakehunter-demo/storefront" },
  window: { since: "2026-09-01T00:00:00.000Z" },
  totals: { runs: 89, tests: 47, results: 4230, passRate: 0.96, flakyTests: 6, flakyShas: 56 },
  lastRunAt: "2026-10-01T18:05:44.000Z",
};
const flaky = {
  data: [
    {
      testId: 63,
      classname: "com.acme.integration.PaymentGatewayIT",
      name: "retriesOnTimeout",
      shasRun: 58,
      flakyShas: 22,
      flakeRate: 0.379,
      lastFlakyAt: "2026-10-01T10:00:00.000Z",
    },
  ],
  page,
};
const history = {
  test: { id: 63, repoId: 3, classname: "com.acme.integration.PaymentGatewayIT", name: "retriesOnTimeout" },
  data: [
    {
      resultId: 9,
      status: "error",
      headSha: "a".repeat(40),
      headBranch: "main",
      occurrenceIndex: 0,
      durationSeconds: 1.2,
      failureMessage: "Read timed out",
      createdAt: "2026-10-01T10:00:00.000Z",
      run: { id: 4, githubRunId: 1422072702, attempt: 2, workflowName: "CI", htmlUrl: null },
    },
  ],
  page,
};

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra }, requestId: "req-7" };
}

async function failure(promise: Promise<unknown>): Promise<ApiClientError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiClientError);
  return err as ApiClientError;
}

describe("request building", () => {
  it("GETs base + path with the bearer token, JSON accept header and no caching", async () => {
    const { calls, fetch } = fakeFetch(() => json(repos));
    const api = createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch });

    await api.get("/api/repos", z.object({ data: z.array(z.unknown()) }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:3000/api/repos");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.cache).toBe("no-store");
    expect(calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
  });

  it("joins onto a base URL that has a path prefix", async () => {
    const { calls, fetch } = fakeFetch(() => json(repos));
    await createApiClient({ apiBaseUrl: "https://example.com/proxy", apiToken: TOKEN, fetch }).listRepos();
    expect(calls[0]?.url).toBe("https://example.com/proxy/api/repos");
  });

  it("leaves out undefined query values and serialises dates as ISO strings", async () => {
    const { calls, fetch } = fakeFetch(() => json(summary));
    const api = createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch });

    await api.getRepoSummary(3, { since: new Date("2026-09-01T00:00:00.000Z") });
    await api.getRepoSummary(3, {});

    expect(calls[0]?.url).toBe("http://localhost:3000/api/repos/3/summary?since=2026-09-01T00%3A00%3A00.000Z");
    expect(calls[1]?.url).toBe("http://localhost:3000/api/repos/3/summary");
  });
});

describe("endpoint wrappers", () => {
  it("listRepos returns typed repos and passes pagination", async () => {
    const { calls, fetch } = fakeFetch(() => json(repos));
    const result = await createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos({
      limit: 20,
      offset: 40,
    });

    expect(calls[0]?.url).toBe("http://localhost:3000/api/repos?limit=20&offset=40");
    expect(result.data[0]?.fullName).toBe("flakehunter-demo/storefront");
    expect(result.page.total).toBe(1);
  });

  it("getFlakyTests encodes owner/name repos and passes every filter", async () => {
    const { calls, fetch } = fakeFetch(() => json(flaky));
    const result = await createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getFlakyTests({
      repo: "flakehunter-demo/storefront",
      since: "2026-09-01T00:00:00.000Z",
      minRuns: 1,
      limit: 25,
      offset: 25,
    });

    expect(calls[0]?.url).toBe(
      "http://localhost:3000/api/tests/flaky?repo=flakehunter-demo%2Fstorefront&since=2026-09-01T00%3A00%3A00.000Z&minRuns=1&limit=25&offset=25",
    );
    expect(result.data[0]).toMatchObject({ testId: 63, name: "retriesOnTimeout", flakyShas: 22 });
  });

  it("getFlakyTests accepts a numeric repo id", async () => {
    const { calls, fetch } = fakeFetch(() => json(flaky));
    await createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getFlakyTests({ repo: 3 });
    expect(calls[0]?.url).toBe("http://localhost:3000/api/tests/flaky?repo=3");
  });

  it("getRepoSummary returns typed totals", async () => {
    const { fetch } = fakeFetch(() => json(summary));
    const result = await createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getRepoSummary(3);
    expect(result.totals.flakyTests).toBe(6);
    expect(result.lastRunAt).toBe("2026-10-01T18:05:44.000Z");
  });

  it("getTestHistory passes status, window and pagination", async () => {
    const { calls, fetch } = fakeFetch(() => json(history));
    const result = await createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getTestHistory(63, {
      status: "error",
      limit: 200,
    });

    expect(calls[0]?.url).toBe("http://localhost:3000/api/tests/63/history?status=error&limit=200");
    expect(result.test.name).toBe("retriesOnTimeout");
    expect(result.data[0]?.run.attempt).toBe(2);
  });
});

describe("errors", () => {
  it("maps the API's standard error body, keeping code, status and request id", async () => {
    const { fetch } = fakeFetch(() => json(errorBody("not_found", "Repo 999 not found"), 404));
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getRepoSummary(999));

    expect(err.code).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req-7");
    expect(err.message).toBe("Repo 999 not found");
    expect(err.details).toBeUndefined();
  });

  it("keeps validation details", async () => {
    const details = [{ path: "querystring.limit", message: "Too big" }];
    const { fetch } = fakeFetch(() =>
      json(errorBody("validation_error", "Request validation failed", { details }), 400),
    );
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos({ limit: 999 }));

    expect(err.code).toBe("validation_error");
    expect(err.status).toBe(400);
    expect(err.details).toEqual(details);
  });

  it("maps an unauthorized response without leaking the token", async () => {
    const { fetch } = fakeFetch(() => json(errorBody("unauthorized", "Missing or invalid API token"), 401));
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos());

    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
  });

  it("falls back to code 'unknown' when an error response is not the standard body (e.g. a proxy's HTML 502)", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos());

    expect(err.code).toBe("unknown");
    expect(err.status).toBe(502);
    expect(err.requestId).toBeUndefined();
    expect(err.message).toContain("502");
  });

  it("reports a network failure as code 'network' with status 0, without echoing the token", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`fetch failed (Authorization: Bearer ${TOKEN})`);
    });
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos());

    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
    expect(err.message).toContain("Could not reach the API");
    expect(err.message).not.toContain(TOKEN);
  });

  it("treats a 200 with a body that is not JSON as an invalid response", async () => {
    const { fetch } = fakeFetch(() => new Response("not json", { status: 200 }));
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).listRepos());

    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(200);
  });

  it("fails loudly when the response does not match the shared schema, naming the offending paths", async () => {
    const drifted = { ...flaky, data: [{ ...flaky.data[0], flakeRate: "high", shasRun: undefined }] };
    const { fetch } = fakeFetch(() => json(drifted));
    const err = await failure(createApiClient({ apiBaseUrl: BASE, apiToken: TOKEN, fetch }).getFlakyTests({ repo: 3 }));

    expect(err.code).toBe("invalid_response");
    expect(err.status).toBe(200);
    const paths = (err.details ?? []).map((d) => d.path);
    expect(paths).toContain("data.0.flakeRate");
    expect(paths).toContain("data.0.shasRun");
  });
});

describe("apiClientFromEnv", () => {
  it("builds a client from validated environment variables", async () => {
    const { calls, fetch } = fakeFetch(() => json(repos));
    const api = apiClientFromEnv({ API_BASE_URL: "http://api.test:3000/", API_TOKEN: TOKEN }, fetch);

    await api.listRepos();

    expect(calls[0]?.url).toBe("http://api.test:3000/api/repos");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws an EnvError for a bad environment", () => {
    expect(() => apiClientFromEnv({ API_BASE_URL: "nope" })).toThrow(EnvError);
  });
});
