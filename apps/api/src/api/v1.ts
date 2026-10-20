import type {
  ReposResponse,
  TestFailuresResponse,
  TestHistoryResponse,
  UploadReportResponse,
  v2,
} from "@flakehunter/shared-types";

/**
 * The domain functions return the neutral (v2) shapes; these turn them into v1 responses, which call the CI run id
 * `githubRunId` and expose neither the CI source nor the host. v2 responses need no mapping.
 */
function toV1Run<R extends { ciRunId: number; ciSource: unknown }>({ ciRunId, ciSource: _, ...rest }: R) {
  return { ...rest, githubRunId: ciRunId };
}

export function toV1Upload(result: v2.UploadReportResponse): UploadReportResponse {
  return { ...result, run: toV1Run(result.run) };
}

export function toV1History(history: v2.TestHistoryResponse): TestHistoryResponse {
  return { ...history, data: history.data.map((item) => ({ ...item, run: toV1Run(item.run) })) };
}

export function toV1Failures(failures: v2.TestFailuresResponse): TestFailuresResponse {
  return { ...failures, data: failures.data.map((item) => ({ ...item, run: toV1Run(item.run) })) };
}

export function toV1Repos(repos: v2.ReposResponse): ReposResponse {
  return { ...repos, data: repos.data.map(({ host: _, ...repo }) => repo) };
}
