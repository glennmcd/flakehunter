import { v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { ApiError } from "../../api/errors.js";
import type { ApiRouteOptions } from "../../api/version.js";
import { getTestFailures } from "../../history/testFailuresQueries.js";

const testFailuresRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tests/:id/failures",
    {
      schema: {
        tags: ["tests"],
        summary: "Get a test's recent failures",
        description:
          "The 50 most recent failed or errored results for a test, newest first, with run details. Not paginated; never includes failure stack traces.",
        params: v2.idParamSchema,
        response: { 200: v2.testFailuresResponseSchema, ...errorResponses(400, 401, 404) },
      },
    },
    async (request) => {
      const failures = await getTestFailures(fastify.db, request.params.id);
      if (!failures) throw new ApiError("not_found", `Test ${request.params.id} not found`);
      return failures;
    },
  );
};

export default testFailuresRoute;
