import {
  type ApiErrorCode,
  errorResponseSchema,
  flakyTestsResponseSchema,
  repoSummaryResponseSchema,
  reposResponseSchema,
  testHistoryResponseSchema,
} from "@flakehunter/shared-types";
import type { z } from "zod";
import { loadEnv } from "./env";

// Server-side only: it carries the API's read token. Call it from Server Components and route handlers, never from
// a client component (the token is deliberately not NEXT_PUBLIC_, so it would not exist there anyway).

/** The API's error codes, plus three the client adds for failures that never produced a standard error body. */
export type ApiClientErrorCode = ApiErrorCode | "network" | "invalid_response" | "unknown";

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiClientErrorCode,
    message: string,
    /** HTTP status; 0 when the request never got a response. */
    readonly status: number,
    readonly requestId?: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface ApiClientConfig {
  apiBaseUrl: string;
  apiToken: string;
  /** Override for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

type QueryValue = string | number | Date | undefined;
type Query = Record<string, QueryValue>;

type TestStatus = "passed" | "failed" | "error" | "skipped";

function buildQuery(params: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

async function toApiError(response: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { error, requestId } = parsed.data;
    return new ApiClientError(error.code, error.message, response.status, requestId, error.details);
  }
  return new ApiClientError("unknown", `The API responded with HTTP ${response.status}`, response.status);
}

export function createApiClient(config: ApiClientConfig) {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");

  /**
   * GETs `path` and returns the body parsed with `schema`. Anything unexpected becomes an ApiClientError:
   * the API's own error body keeps its code, status and request id; a body that does not match the schema is
   * an "invalid_response" naming the offending paths, so contract drift fails loudly instead of rendering wrong data.
   */
  async function get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.infer<S>> {
    const fetchFn = config.fetch ?? fetch;

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}${buildQuery(query)}`, {
        method: "GET",
        cache: "no-store",
        headers: { authorization: `Bearer ${config.apiToken}`, accept: "application/json" },
      });
    } catch {
      // The underlying error is dropped on purpose: runtimes sometimes echo request headers in it.
      throw new ApiClientError("network", `Could not reach the API at ${baseUrl}`, 0);
    }

    if (!response.ok) throw await toApiError(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiClientError(
        "invalid_response",
        "The API returned a response that is not valid JSON",
        response.status,
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiClientError(
        "invalid_response",
        "The API response did not match the expected shape",
        response.status,
        undefined,
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    return parsed.data;
  }

  return {
    get,

    listRepos: (params: { limit?: number; offset?: number } = {}) =>
      get("/api/repos", reposResponseSchema, { limit: params.limit, offset: params.offset }),

    getRepoSummary: (repoId: number, params: { since?: Date | string } = {}) =>
      get(`/api/repos/${repoId}/summary`, repoSummaryResponseSchema, { since: params.since }),

    getFlakyTests: (params: {
      repo: string | number;
      since?: Date | string;
      minRuns?: number;
      limit?: number;
      offset?: number;
    }) =>
      get("/api/tests/flaky", flakyTestsResponseSchema, {
        repo: params.repo,
        since: params.since,
        minRuns: params.minRuns,
        limit: params.limit,
        offset: params.offset,
      }),

    getTestHistory: (
      testId: number,
      params: { since?: Date | string; status?: TestStatus; limit?: number; offset?: number } = {},
    ) =>
      get(`/api/tests/${testId}/history`, testHistoryResponseSchema, {
        since: params.since,
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** A client configured from API_BASE_URL and API_TOKEN; throws an EnvError if they are missing or invalid. */
export function apiClientFromEnv(
  source: Record<string, string | undefined> = process.env,
  fetchFn?: typeof fetch,
): ApiClient {
  const env = loadEnv(source);
  return createApiClient({ apiBaseUrl: env.apiBaseUrl, apiToken: env.apiToken, fetch: fetchFn });
}
