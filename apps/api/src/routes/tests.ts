import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { testResults, workflowRuns } from "../db/schema.js";

interface RouteParams {
  id: string;
  testCaseId: string;
}

const testResultsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: RouteParams }>("/repos/:id/tests/:testCaseId/results", async (request, reply) => {
    const repoId = Number(request.params.id);
    const testCaseId = Number(request.params.testCaseId);
    if (!Number.isInteger(repoId) || !Number.isInteger(testCaseId)) {
      return reply.code(400).send({ error: "invalid repo id or test case id" });
    }

    return fastify.db
      .select({
        id: testResults.id,
        status: testResults.status,
        headSha: testResults.headSha,
        occurrenceIndex: testResults.occurrenceIndex,
        durationSeconds: testResults.durationSeconds,
        failureMessage: testResults.failureMessage,
        failureStack: testResults.failureStack,
        createdAt: testResults.createdAt,
        runId: testResults.runId,
        workflowName: workflowRuns.workflowName,
        htmlUrl: workflowRuns.htmlUrl,
      })
      .from(testResults)
      .innerJoin(workflowRuns, eq(workflowRuns.id, testResults.runId))
      .where(and(eq(testResults.repoId, repoId), eq(testResults.testCaseId, testCaseId)))
      .orderBy(desc(testResults.createdAt));
  });
};

export default testResultsRoute;
