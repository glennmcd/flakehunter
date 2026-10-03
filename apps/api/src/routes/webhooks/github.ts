import type { GithubWorkflowRunEvent } from "@flakehunter/shared-types";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { repos, webhookEvents } from "../../db/schema.js";
import { workflowRunSkipReason } from "../../github/runSource.js";
import { createWebhookVerifier } from "../../github/webhookVerify.js";
import { ArtifactRejectedError } from "../../ingest/limits.js";
import { processWorkflowRun } from "../../ingest/processWorkflowRun.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const githubWebhookRoute: FastifyPluginAsync = async (fastify) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is not set");
  }
  const verifier = createWebhookVerifier(secret);

  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req: FastifyRequest, body: Buffer, done) => {
    req.rawBody = body;
    try {
      const json = body.length ? JSON.parse(body.toString("utf8")) : {};
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post("/github", async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"];
    const deliveryId = request.headers["x-github-delivery"];
    const eventType = request.headers["x-github-event"];

    if (typeof deliveryId !== "string" || typeof eventType !== "string" || !request.rawBody) {
      return reply.code(400).send({ error: "missing required headers or body" });
    }

    const valid = await verifier.verify(
      request.rawBody.toString("utf8"),
      typeof signature === "string" ? signature : undefined,
    );
    if (!valid) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const payload = request.body as Record<string, unknown>;

    const [eventRow] = await fastify.db
      .insert(webhookEvents)
      .values({ deliveryId, eventType, payload })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });

    // No row returned means this delivery_id was already processed (GitHub redelivery); skip.
    if (!eventRow) {
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    if (eventType === "workflow_run" && (payload as unknown as GithubWorkflowRunEvent).action === "completed") {
      const event = payload as unknown as GithubWorkflowRunEvent;
      let processingError: string | null;
      try {
        processingError = await handleCompletedRun(fastify, event);
      } catch (err) {
        request.log.error(err, "failed to process workflow_run webhook");
        // Raw error text can carry query parameters or connection details; the full error is in the log above.
        processingError = err instanceof ArtifactRejectedError ? err.message : "processing failed; see the API logs";
      }
      await fastify.db
        .update(webhookEvents)
        .set(processingError ? { processingError } : { processedAt: sql`now()` })
        .where(eq(webhookEvents.id, eventRow.id));
    }

    return reply.code(200).send({ ok: true });
  });
};

/** Ingests a completed workflow run. Returns null when it was processed, or why it was not. */
async function handleCompletedRun(fastify: FastifyInstance, event: GithubWorkflowRunEvent): Promise<string | null> {
  const skipReason = workflowRunSkipReason(event);
  if (skipReason) return skipReason;

  const [repo] = await fastify.db.select().from(repos).where(eq(repos.githubRepoId, event.repository.id));
  if (!repo) return `no repo registered for github_repo_id ${event.repository.id}`;

  await processWorkflowRun(fastify.db, fastify.github, {
    repoId: repo.id,
    // From the registered row, not the payload: the repo id is what was matched, so the name must follow it.
    owner: repo.owner,
    repo: repo.name,
    githubRunId: event.workflow_run.id,
    githubRunAttempt: event.workflow_run.run_attempt,
    workflowName: event.workflow_run.name,
    headSha: event.workflow_run.head_sha,
    headBranch: event.workflow_run.head_branch,
    status: event.workflow_run.status,
    conclusion: event.workflow_run.conclusion,
    runStartedAt: event.workflow_run.run_started_at,
    runCompletedAt: event.workflow_run.updated_at,
    htmlUrl: event.workflow_run.html_url,
  });
  return null;
}

export default githubWebhookRoute;
