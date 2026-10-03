import { idParamSchema, testFailuresResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "../../api/errors.js";
import { getTestFailures } from "../../history/testFailuresQueries.js";

const testFailuresRoute: FastifyPluginAsync = async (fastify) => {
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/tests/:id/failures",
      { schema: { params: idParamSchema, response: { 200: testFailuresResponseSchema } } },
      async (request) => {
        const failures = await getTestFailures(fastify.db, request.params.id);
        if (!failures) throw new ApiError("not_found", `Test ${request.params.id} not found`);
        return failures;
      },
    );
};

export default testFailuresRoute;
