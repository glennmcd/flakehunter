import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createWebhookVerifier } from "../../github/webhookVerify.js";
import { webhookEvents } from "../../db/schema.js";

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

    await fastify.db
      .insert(webhookEvents)
      .values({
        deliveryId,
        eventType,
        payload,
      })
      .onConflictDoNothing();

    // Day 3 wires actual ingestion (fetch artifacts -> parse -> persist) here,
    // triggered only for eventType === "workflow_run" && payload.action === "completed".

    return reply.code(200).send({ ok: true });
  });
};

export default githubWebhookRoute;
