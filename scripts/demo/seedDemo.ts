import { DEFAULT_DEMO_SEED, type DemoRun } from "./generateRuns.js";

// Uploads generated demo runs through POST /api/reports. Only node built-ins and global fetch are used, because
// scripts at the repo root cannot resolve the API's dependencies.

export interface SeedConfig {
  apiUrl: string;
  token: string;
  days: number;
  seed: number;
  dryRun: boolean;
}

const MAX_DAYS = 365;

/** Reads DEMO_API_URL, DEMO_UPLOAD_TOKEN, DEMO_DAYS and DEMO_SEED plus the --dry-run flag, failing with a clear message. */
export function parseSeedConfig(env: Record<string, string | undefined>, argv: string[]): SeedConfig {
  const dryRun = argv.includes("--dry-run");

  const rawUrl = env.DEMO_API_URL ?? "http://localhost:3000";
  if (!/^https?:\/\/.+/.test(rawUrl)) {
    throw new Error(`DEMO_API_URL must start with http:// or https:// (got "${rawUrl}")`);
  }

  const token = env.DEMO_UPLOAD_TOKEN ?? "";
  if (!token && !dryRun) {
    throw new Error("Set DEMO_UPLOAD_TOKEN to the demo repo's upload token (see scripts/create-repo-token.ts)");
  }

  const days = env.DEMO_DAYS === undefined ? 30 : Number(env.DEMO_DAYS);
  if (!/^\d+$/.test(env.DEMO_DAYS ?? "0") || !Number.isInteger(days) || days > MAX_DAYS) {
    throw new Error(`DEMO_DAYS must be a whole number between 0 and ${MAX_DAYS} (got "${env.DEMO_DAYS}")`);
  }

  const seed = env.DEMO_SEED === undefined ? DEFAULT_DEMO_SEED : Number(env.DEMO_SEED);
  if (!/^\d+$/.test(env.DEMO_SEED ?? "0") || !Number.isSafeInteger(seed)) {
    throw new Error(`DEMO_SEED must be a non-negative whole number (got "${env.DEMO_SEED}")`);
  }

  return { apiUrl: rawUrl.replace(/\/+$/, ""), token, days, seed, dryRun };
}

export interface UploadRequest {
  runId: number;
  attempt: number;
  headSha: string;
  branch: string;
  workflow: string;
  reportKey: string;
  timestamp: Date;
  xml: string;
}

export interface UploadResponse {
  status: number;
  body?: string;
  retryAfterSeconds?: number;
}

export type Uploader = (request: UploadRequest) => Promise<UploadResponse>;

export function uploadHeaders(request: UploadRequest, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/xml",
    "x-fh-run-id": String(request.runId),
    "x-fh-run-attempt": String(request.attempt),
    "x-fh-sha": request.headSha,
    "x-fh-branch": request.branch,
    "x-fh-workflow": request.workflow,
    "x-fh-report-key": request.reportKey,
    "x-fh-timestamp": request.timestamp.toISOString(),
  };
}

/** An uploader that POSTs to a running API over HTTP. */
export function httpUploader(baseUrl: string, token: string, fetchFn: typeof fetch = fetch): Uploader {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/reports`;
  return async (request) => {
    const response = await fetchFn(url, { method: "POST", headers: uploadHeaders(request, token), body: request.xml });
    const retryAfter = response.headers.get("retry-after");
    return {
      status: response.status,
      body: await response.text(),
      retryAfterSeconds: retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
    };
  };
}

export class SeedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "SeedError";
  }
}

export interface SeedOptions {
  sleep?: (ms: number) => Promise<void>;
  /** How many times one upload is retried after a 429 before giving up. */
  maxRetries?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SeedSummary {
  /** Reports that completed (created or recognised as duplicates). */
  uploads: number;
  created: number;
  duplicates: number;
  /** Extra attempts caused by 429 responses. */
  retries: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 1000;

/**
 * Uploads every report of every run, in order. 201 counts as created and 200 as a duplicate (the API's idempotency),
 * a 429 is waited out (Retry-After, or a growing default) and retried, and anything else stops the seed with a
 * SeedError so a bad token or URL fails on the first request rather than after hundreds.
 */
export async function seedDemo(runs: DemoRun[], upload: Uploader, options: SeedOptions = {}): Promise<SeedSummary> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const total = runs.reduce((sum, run) => sum + run.reports.length, 0);
  const summary: SeedSummary = { uploads: 0, created: 0, duplicates: 0, retries: 0 };

  for (const run of runs) {
    for (const report of run.reports) {
      const request: UploadRequest = {
        runId: run.runId,
        attempt: run.attempt,
        headSha: run.headSha,
        branch: run.branch,
        workflow: run.workflow,
        reportKey: report.reportKey,
        timestamp: run.timestamp,
        xml: report.xml,
      };

      let retriesUsed = 0;
      for (;;) {
        const response = await upload(request);
        if (response.status === 201) {
          summary.created++;
          break;
        }
        if (response.status === 200) {
          summary.duplicates++;
          break;
        }
        if (response.status === 429 && retriesUsed < maxRetries) {
          retriesUsed++;
          summary.retries++;
          await sleep(
            response.retryAfterSeconds === undefined
              ? DEFAULT_BACKOFF_MS * retriesUsed
              : response.retryAfterSeconds * 1000,
          );
          continue;
        }
        throw new SeedError(
          `Upload of run ${run.runId} attempt ${run.attempt} (${report.reportKey}) failed with HTTP ${response.status}` +
            (response.body ? `: ${response.body}` : ""),
          response.status,
          response.body,
        );
      }

      summary.uploads++;
      options.onProgress?.(summary.uploads, total);
    }
  }

  return summary;
}
