import { reposQuerySchema, reposResponseSchema, v2 } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { toV1Repos } from "../../api/v1.js";
import type { ApiRouteOptions } from "../../api/version.js";
import { listRepos } from "../../repos/repoQueries.js";

const reposRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify, { apiVersion }) => {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/repos",
    {
      schema: {
        tags: ["repos"],
        summary: "List repositories",
        description: "Paginated, ordered by full name. Use it to find a repository's numeric id.",
        querystring: reposQuerySchema,
        response: {
          200: apiVersion === 1 ? reposResponseSchema : v2.reposResponseSchema,
          ...errorResponses(400, 401),
        },
      },
    },
    async (request) => {
      const repos = await listRepos(fastify.db, request.query);
      return apiVersion === 1 ? toV1Repos(repos) : repos;
    },
  );
};

export default reposRoute;
