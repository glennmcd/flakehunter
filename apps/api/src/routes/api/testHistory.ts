import { idParamSchema, testHistoryQuerySchema, testHistoryResponseSchema, v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { ApiError } from "../../api/errors.js";
import { toV1History } from "../../api/v1.js";
import type { ApiRouteOptions } from "../../api/version.js";
import { getTestHistory } from "../../history/testHistoryQueries.js";

const testHistoryRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify, { apiVersion }) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tests/:id/history",
    {
      schema: {
        tags: ["tests"],
        summary: "Get a test's history",
        description: "Results for one test, newest first. Never includes failure stack traces.",
        params: idParamSchema,
        querystring: testHistoryQuerySchema,
        response: {
          200: apiVersion === 1 ? testHistoryResponseSchema : v2.testHistoryResponseSchema,
          ...errorResponses(400, 401, 404),
        },
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
      return apiVersion === 1 ? toV1History(history) : history;
    },
  );
};

export default testHistoryRoute;
