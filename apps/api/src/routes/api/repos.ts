import { v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import type { ApiRouteOptions } from "../../api/version.js";
import { listRepos } from "../../repos/repoQueries.js";

const reposRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/repos",
    {
      schema: {
        tags: ["repos"],
        summary: "List repositories",
        description: "Paginated, ordered by full name. Use it to find a repository's numeric id.",
        querystring: v2.reposQuerySchema,
        response: { 200: v2.reposResponseSchema, ...errorResponses(400, 401) },
      },
    },
    async (request) => {
      return listRepos(fastify.db, request.query);
    },
  );
};

export default reposRoute;
