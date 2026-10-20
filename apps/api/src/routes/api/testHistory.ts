import { v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { ApiError } from "../../api/errors.js";
import type { ApiRouteOptions } from "../../api/version.js";
import { getTestHistory } from "../../history/testHistoryQueries.js";

const testHistoryRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tests/:id/history",
    {
      schema: {
        tags: ["tests"],
        summary: "Get a test's history",
        description: "Results for one test, newest first. Never includes failure stack traces.",
        params: v2.idParamSchema,
        querystring: v2.testHistoryQuerySchema,
        response: { 200: v2.testHistoryResponseSchema, ...errorResponses(400, 401, 404) },
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
