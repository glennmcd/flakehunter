import { flakyTestsQuerySchema, flakyTestsResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { resolveRepo } from "../../api/resolveRepo.js";
import { getFlakeRanking } from "../../flaky/flakeRateQueries.js";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const flakyTestsRoute: FastifyPluginAsync = async (fastify) => {
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/tests/flaky",
      { schema: { querystring: flakyTestsQuerySchema, response: { 200: flakyTestsResponseSchema } } },
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
