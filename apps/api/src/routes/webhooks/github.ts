import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { GithubWorkflowRunEvent } from "@flakehunter/shared-types";
import { createWebhookVerifier } from "../../github/webhookVerify.js";
import { repos, webhookEvents } from "../../db/schema.js";
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

  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      try {
        const json = body.length ? JSON.parse(body.toString("utf8")) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
      try {
        const [repo] = await fastify.db
          .select()
          .from(repos)
          .where(eq(repos.githubRepoId, event.repository.id));

        if (!repo) {
          await fastify.db
            .update(webhookEvents)
            .set({ processingError: `no repo registered for github_repo_id ${event.repository.id}` })
            .where(eq(webhookEvents.id, eventRow.id));
        } else {
          await processWorkflowRun(fastify.db, fastify.github, {
            repoId: repo.id,
            owner: event.repository.owner.login,
            repo: event.repository.name,
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
          await fastify.db
            .update(webhookEvents)
            .set({ processedAt: sql`now()` })
            .where(eq(webhookEvents.id, eventRow.id));
        }
      } catch (err) {
        request.log.error(err, "failed to process workflow_run webhook");
        await fastify.db
          .update(webhookEvents)
          .set({ processingError: err instanceof Error ? err.message : String(err) })
          .where(eq(webhookEvents.id, eventRow.id));
      }
    }

    return reply.code(200).send({ ok: true });
  });
};

export default githubWebhookRoute;
