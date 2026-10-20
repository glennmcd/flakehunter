/** Major versions of the published API. v1 is served under /api, v2 under /api/v2 (docs/plans/api-v2.md). */
export type ApiVersion = 1 | 2;

export const API_VERSIONS: readonly ApiVersion[] = [1, 2];

/** Options every versioned route plugin is registered with, once per version. */
export interface ApiRouteOptions {
  apiVersion: ApiVersion;
}

/** The URL prefix of a version's mount: `/api` for v1, `/api/v2` for v2. */
export function apiPrefix(version: ApiVersion): string {
  return version === 1 ? "/api" : `/api/v${version}`;
}
