import { idParamSchema, repoSummaryQuerySchema, repoSummaryResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { resolveRepo } from "../../api/resolveRepo.js";
import { getRepoSummary } from "../../summary/repoSummaryQueries.js";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const repoSummaryRoute: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/repos/:id/summary",
    {
      schema: {
        params: idParamSchema,
        querystring: repoSummaryQuerySchema,
        response: { 200: repoSummaryResponseSchema },
      },
    },
    async (request) => {
      const repo = await resolveRepo(fastify.db, { id: request.params.id });
      const since = request.query.since ? new Date(request.query.since) : new Date(Date.now() - DEFAULT_WINDOW_MS);

      const { totals, lastRunAt } = await getRepoSummary(fastify.db, { repoId: repo.id, since });
      return { repo, window: { since: since.toISOString() }, totals, lastRunAt };
    },
  );
};

export default repoSummaryRoute;
