import { errorResponseSchema, flakyTestsResponseSchema } from "@flakehunter/shared-types";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** HTTP status; 0 when the request never got a response. */
    readonly status: number,
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

export interface FlakyTestsParams {
  repo: string;
  since?: string;
  minRuns?: number;
  limit?: number;
}

export function createApiClient(config: ApiClientConfig) {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const fetchFn = config.fetch ?? fetch;

  async function getFlakyTests(params: FlakyTestsParams) {
    const search = new URLSearchParams({ repo: params.repo });
    if (params.since !== undefined) search.set("since", params.since);
    if (params.minRuns !== undefined) search.set("minRuns", String(params.minRuns));
    if (params.limit !== undefined) search.set("limit", String(params.limit));

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/api/tests/flaky?${search}`, {
        headers: { authorization: `Bearer ${config.apiToken}`, accept: "application/json" },
      });
    } catch {
      // The underlying error is dropped on purpose: runtimes sometimes echo request headers in it.
      throw new ApiClientError("network", `Could not reach the API at ${baseUrl}`, 0);
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      if (parsed.success) throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, response.status);
      throw new ApiClientError("unknown", `The API responded with HTTP ${response.status}`, response.status);
    }

    const parsed = flakyTestsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiClientError(
        "invalid_response",
        "The API response did not match the expected shape",
        response.status,
      );
    }
    return parsed.data;
  }

  return { getFlakyTests };
}

export type ApiClient = ReturnType<typeof createApiClient>;
