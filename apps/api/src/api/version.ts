import type { FastifyInstance, FastifyPluginAsync } from "fastify";

/**
 * Major versions of the published API, each under `/api/v<n>`. Only v2 is served; v1 (`/api`) was removed once every
 * first-party consumer had moved (docs/decisions/0012-api-v2-alongside-v1.md). A breaking change adds the next version
 * here and is served next to the current one (docs/decisions/0010-openapi-published-contract.md).
 */
export type ApiVersion = 2;

export const API_VERSIONS: readonly ApiVersion[] = [2];

/** Options every versioned route plugin is registered with, once per version. */
export interface ApiRouteOptions {
  apiVersion: ApiVersion;
}

/** Where each version's OpenAPI document and docs page are served. */
export const SPEC_URLS: Record<ApiVersion, string> = { 2: "/openapi.v2.json" };
export const DOCS_URLS: Record<ApiVersion, string> = { 2: "/docs/v2" };

/** The URL prefix of a version's mount, e.g. `/api/v2`. */
export function apiPrefix(version: ApiVersion): string {
  return `/api/v${version}`;
}

/** Mounts one version's route plugins under its prefix, in their own encapsulated context. */
export async function registerApiVersion(
  fastify: FastifyInstance,
  apiVersion: ApiVersion,
  plugins: readonly FastifyPluginAsync<ApiRouteOptions>[],
): Promise<void> {
  await fastify.register(
    async (scope) => {
      for (const plugin of plugins) {
        await scope.register(plugin, { apiVersion });
      }
    },
    { prefix: apiPrefix(apiVersion) },
  );
}
