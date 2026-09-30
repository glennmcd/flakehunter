import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    throw new Error("API_TOKEN is not set");
  }

  fastify.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/webhooks/github" || path === "/health") {
      return;
    }
    const header = request.headers.authorization;
    if (header !== `Bearer ${apiToken}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
};

export default fp(authPlugin);
