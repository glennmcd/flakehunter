import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { workflowRuns } from "../db/schema.js";

interface RouteParams {
  id: string;
}

const runsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: RouteParams }>("/repos/:id/runs", async (request, reply) => {
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) {
      return reply.code(400).send({ error: "invalid repo id" });
    }

    return fastify.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.repoId, repoId))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(50);
  });
};

export default runsRoute;
