import type { FastifyInstance, FastifyPluginAsync } from "fastify";

/** Major versions of the published API. v1 is served under /api, v2 under /api/v2 (docs/plans/api-v2.md). */
export type ApiVersion = 1 | 2;

export const API_VERSIONS: readonly ApiVersion[] = [1, 2];

/** Options every versioned route plugin is registered with, once per version. */
export interface ApiRouteOptions {
  apiVersion: ApiVersion;
}

/** Where each version's OpenAPI document and docs page are served. */
export const SPEC_URLS: Record<ApiVersion, string> = { 1: "/openapi.json", 2: "/openapi.v2.json" };
export const DOCS_URLS: Record<ApiVersion, string> = { 1: "/docs", 2: "/docs/v2" };

/** The URL prefix of a version's mount: `/api` for v1, `/api/v2` for v2. */
export function apiPrefix(version: ApiVersion): string {
  return version === 1 ? "/api" : `/api/v${version}`;
}

/** When v1 was deprecated in favour of v2. Sent in the RFC 9745 `Deprecation` header of every v1 response. */
export const V1_DEPRECATED_AT = new Date("2026-10-19T00:00:00Z");

/** The headers on every v1 response, errors and 429s included: the deprecation date and where v2 is. */
export const V1_DEPRECATION_HEADERS = {
  deprecation: `@${Math.floor(V1_DEPRECATED_AT.getTime() / 1000)}`,
  link: `<${SPEC_URLS[2]}>; rel="successor-version", <${DOCS_URLS[2]}>; rel="deprecation"`,
} as const;

/**
 * Mounts one version's route plugins under its prefix, in their own encapsulated context. For v1 that context also
 * gets the onSend hook that adds V1_DEPRECATION_HEADERS, so the headers reach every v1 route and nothing else.
 */
export async function registerApiVersion(
  fastify: FastifyInstance,
  apiVersion: ApiVersion,
  plugins: readonly FastifyPluginAsync<ApiRouteOptions>[],
): Promise<void> {
  await fastify.register(
    async (scope) => {
      if (apiVersion === 1) {
        scope.addHook("onSend", async (_request, reply, payload) => {
          reply.headers(V1_DEPRECATION_HEADERS);
          return payload;
        });
      }
      for (const plugin of plugins) {
        await scope.register(plugin, { apiVersion });
      }
    },
    { prefix: apiPrefix(apiVersion) },
  );
}
