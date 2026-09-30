import { idParamSchema, testHistoryQuerySchema, testHistoryResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "../../api/errors.js";
import { getTestHistory } from "../../history/testHistoryQueries.js";

const testHistoryRoute: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tests/:id/history",
    {
      schema: {
        params: idParamSchema,
        querystring: testHistoryQuerySchema,
        response: { 200: testHistoryResponseSchema },
      },
    },
    async (request) => {
      const { since, status, limit, offset } = request.query;
      const history = await getTestHistory(fastify.db, {
        testId: request.params.id,
        since: since ? new Date(since) : undefined,
        status,
        limit,
        offset,
      });
      if (!history) throw new ApiError("not_found", `Test ${request.params.id} not found`);
      return history;
    },
  );
};

export default testHistoryRoute;
