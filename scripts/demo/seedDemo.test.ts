import { describe, expect, it } from "bun:test";
import { DEFAULT_DEMO_SEED, generateDemoRuns } from "./generateRuns.js";
import {
  httpUploader,
  parseSeedConfig,
  SeedError,
  seedDemo,
  type UploadRequest,
  type UploadResponse,
  uploadHeaders,
} from "./seedDemo.js";

const NOW = new Date("2026-10-01T15:00:00.000Z");
const runs = generateDemoRuns({ seed: DEFAULT_DEMO_SEED, days: 2, now: NOW });
const totalReports = runs.reduce((sum, r) => sum + r.reports.length, 0);

const sample: UploadRequest = {
  runId: 1_420_000_123,
  attempt: 2,
  headSha: "a".repeat(40),
  branch: "feature/x",
  workflow: "CI",
  reportKey: "unit",
  timestamp: new Date("2026-09-30T10:20:30.000Z"),
  xml: "<testsuite/>",
};

describe("parseSeedConfig", () => {
  it("applies defaults when only the token is set", () => {
    expect(parseSeedConfig({ DEMO_UPLOAD_TOKEN: "fh_x" }, [])).toEqual({
      apiUrl: "http://localhost:3000",
      token: "fh_x",
      days: 30,
      seed: DEFAULT_DEMO_SEED,
      dryRun: false,
    });
  });

  it("reads overrides, trims a trailing slash and recognises --dry-run", () => {
    const config = parseSeedConfig(
      { DEMO_UPLOAD_TOKEN: "fh_x", DEMO_API_URL: "https://demo.example.com/", DEMO_DAYS: "7", DEMO_SEED: "99" },
      ["--dry-run"],
    );
    expect(config).toEqual({ apiUrl: "https://demo.example.com", token: "fh_x", days: 7, seed: 99, dryRun: true });
  });

  it("requires a token, except for a dry run", () => {
    expect(() => parseSeedConfig({}, [])).toThrow("DEMO_UPLOAD_TOKEN");
    expect(parseSeedConfig({}, ["--dry-run"]).token).toBe("");
  });

  it("rejects a bad URL, days or seed with a message naming the variable", () => {
    const env = { DEMO_UPLOAD_TOKEN: "fh_x" };
    expect(() => parseSeedConfig({ ...env, DEMO_API_URL: "localhost:3000" }, [])).toThrow("DEMO_API_URL");
    for (const days of ["abc", "-1", "1.5", "400"]) {
      expect(() => parseSeedConfig({ ...env, DEMO_DAYS: days }, [])).toThrow("DEMO_DAYS");
    }
    for (const seed of ["abc", "1.5", ""]) {
      expect(() => parseSeedConfig({ ...env, DEMO_SEED: seed }, [])).toThrow("DEMO_SEED");
    }
  });
});

describe("uploadHeaders", () => {
  it("maps a request onto the X-FH-* headers, with an ISO timestamp", () => {
    expect(uploadHeaders(sample, "fh_secret")).toEqual({
      authorization: "Bearer fh_secret",
      "content-type": "application/xml",
      "x-fh-run-id": "1420000123",
      "x-fh-run-attempt": "2",
      "x-fh-sha": "a".repeat(40),
      "x-fh-branch": "feature/x",
      "x-fh-workflow": "CI",
      "x-fh-report-key": "unit",
      "x-fh-timestamp": "2026-09-30T10:20:30.000Z",
    });
  });
});

describe("httpUploader", () => {
  it("POSTs the XML to /api/reports with the headers and returns status, body and Retry-After", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"slow down"}', { status: 429, headers: { "retry-after": "7" } });
    }) as unknown as typeof fetch;

    const response = await httpUploader("https://demo.example.com", "fh_secret", fakeFetch)(sample);

    expect(response).toEqual({ status: 429, body: '{"error":"slow down"}', retryAfterSeconds: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://demo.example.com/api/reports");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("<testsuite/>");
    expect(calls[0]?.init.headers).toEqual(uploadHeaders(sample, "fh_secret"));
  });

  it("omits retryAfterSeconds when the header is absent or not a number", async () => {
    const make = (headers: Record<string, string>) =>
      httpUploader(
        "http://x",
        "t",
        (async () => new Response("ok", { status: 201, headers })) as unknown as typeof fetch,
      );
    expect((await make({})(sample)).retryAfterSeconds).toBeUndefined();
    expect((await make({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })(sample)).retryAfterSeconds).toBeUndefined();
  });
});

describe("seedDemo", () => {
  const noSleep = async () => {};

  it("uploads every report of every run in order and counts created vs duplicate", async () => {
    const seen: UploadRequest[] = [];
    let n = 0;
    const upload = async (req: UploadRequest): Promise<UploadResponse> => {
      seen.push(req);
      return { status: n++ % 2 === 0 ? 201 : 200 };
    };
    const progress: [number, number][] = [];

    const summary = await seedDemo(runs, upload, { onProgress: (done, total) => progress.push([done, total]) });

    expect(seen).toHaveLength(totalReports);
    expect(summary).toEqual({
      uploads: totalReports,
      created: Math.ceil(totalReports / 2),
      duplicates: Math.floor(totalReports / 2),
      retries: 0,
    });
    expect(seen[0]).toMatchObject({
      runId: runs[0]?.runId,
      attempt: 1,
      headSha: runs[0]?.headSha,
      workflow: "CI",
      reportKey: runs[0]?.reports[0]?.reportKey,
      timestamp: runs[0]?.timestamp,
      xml: runs[0]?.reports[0]?.xml,
    });
    expect(progress.at(-1)).toEqual([totalReports, totalReports]);
    expect(progress).toHaveLength(totalReports);
  });

  it("stops at the first rejected upload with an error carrying the status, body and run", async () => {
    let calls = 0;
    const upload = async (): Promise<UploadResponse> => {
      calls++;
      return { status: 401, body: '{"error":{"code":"unauthorized"}}' };
    };

    const err = await seedDemo(runs, upload).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SeedError);
    expect((err as SeedError).status).toBe(401);
    expect((err as SeedError).message).toContain("401");
    expect((err as SeedError).message).toContain("unauthorized");
    expect((err as SeedError).message).toContain(String(runs[0]?.runId));
    expect(calls).toBe(1);
  });

  it("waits and retries on 429, honouring Retry-After, then carries on", async () => {
    const sleeps: number[] = [];
    let first = true;
    const upload = async (): Promise<UploadResponse> => {
      if (first) {
        first = false;
        return { status: 429, retryAfterSeconds: 3 };
      }
      return { status: 201 };
    };

    const summary = await seedDemo(runs, upload, { sleep: async (ms) => void sleeps.push(ms) });

    expect(sleeps).toEqual([3000]);
    expect(summary).toMatchObject({ uploads: totalReports, created: totalReports, retries: 1 });
  });

  it("uses a default wait when 429 has no Retry-After, and gives up after maxRetries", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const upload = async (): Promise<UploadResponse> => {
      calls++;
      return { status: 429 };
    };

    const err = await seedDemo(runs, upload, { sleep: async (ms) => void sleeps.push(ms), maxRetries: 3 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SeedError);
    expect((err as SeedError).status).toBe(429);
    expect(calls).toBe(4); // first try + 3 retries
    expect(sleeps).toHaveLength(3);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("treats any other status as a failure and lets network errors through", async () => {
    const serverError = await seedDemo(runs, async () => ({ status: 500, body: "boom" }), { sleep: noSleep }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((serverError as SeedError).status).toBe(500);

    await expect(
      seedDemo(
        runs,
        async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("does nothing for an empty history", async () => {
    let calls = 0;
    const summary = await seedDemo([], async () => {
      calls++;
      return { status: 201 };
    });
    expect(calls).toBe(0);
    expect(summary).toEqual({ uploads: 0, created: 0, duplicates: 0, retries: 0 });
  });
});
