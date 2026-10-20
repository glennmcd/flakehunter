import { flakyTestsQuerySchema, flakyTestsResponseSchema, v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { resolveRepo } from "../../api/resolveRepo.js";
import type { ApiRouteOptions, ApiVersion } from "../../api/version.js";
import { getFlakeRanking } from "../../flaky/flakeRateQueries.js";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const REPO_PARAM: Record<ApiVersion, string> = {
  1: "repo is owner/name or a numeric id.",
  2: "repo is a numeric id or a path (owner/name, group/sub/project), optionally prefixed with its host (github:acme/widgets). A path without a host that matches repositories on more than one host is a 400.",
};

const flakyTestsRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify, { apiVersion }) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tests/flaky",
    {
      schema: {
        tags: ["tests"],
        summary: "Rank flaky tests",
        description: `Flake rate = flaky SHAs / SHAs run in the window (skipped results ignored). Only tests with at least minRuns SHAs and one flaky SHA appear, most flaky first. ${REPO_PARAM[apiVersion]}`,
        querystring: apiVersion === 1 ? flakyTestsQuerySchema : v2.flakyTestsQuerySchema,
        response: { 200: flakyTestsResponseSchema, ...errorResponses(400, 401, 404) },
      },
    },
    async (request) => {
      const { repo: ref, since, minRuns, limit, offset } = request.query;
      const repo = await resolveRepo(fastify.db, ref);

      const { data, total } = await getFlakeRanking(fastify.db, {
        repoId: repo.id,
        since: since ? new Date(since) : new Date(Date.now() - DEFAULT_WINDOW_MS),
        minRuns,
        limit,
        offset,
      });

      return { data, page: { limit, offset, total } };
    },
  );
};

export default flakyTestsRoute;
