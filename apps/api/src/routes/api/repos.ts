import { reposQuerySchema, reposResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { listRepos } from "../../repos/repoQueries.js";

const reposRoute: FastifyPluginAsync = async (fastify) => {
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/repos",
      { schema: { querystring: reposQuerySchema, response: { 200: reposResponseSchema } } },
      async (request) => listRepos(fastify.db, request.query),
    );
};

export default reposRoute;
