import { reposQuerySchema, reposResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { listRepos } from "../../repos/repoQueries.js";

const reposRoute: FastifyPluginAsync = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/repos",
    {
      schema: {
        tags: ["repos"],
        summary: "List repositories",
        description: "Paginated, ordered by full name. Use it to find a repository's numeric id.",
        querystring: reposQuerySchema,
        response: { 200: reposResponseSchema, ...errorResponses(400, 401) },
      },
    },
    async (request) => listRepos(fastify.db, request.query),
  );
};

export default reposRoute;
