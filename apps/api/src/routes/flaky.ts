import type { FastifyPluginAsync } from "fastify";
import { getFlakyTests, getFlakyTestsSummary } from "../flaky/flakyQueries.js";

interface RouteParams {
  id: string;
}

interface RouteQuery {
  summary?: string;
}

const flakyRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: RouteParams; Querystring: RouteQuery }>("/repos/:id/flaky-tests", async (request, reply) => {
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) {
      return reply.code(400).send({ error: "invalid repo id" });
    }

    if (request.query.summary === "true") {
      return getFlakyTestsSummary(fastify.db, repoId);
    }
    return getFlakyTests(fastify.db, repoId);
  });
};

export default flakyRoute;
