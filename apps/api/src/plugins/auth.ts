import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { errorBody } from "../api/errors.js";

// Routes that skip the global Bearer API_TOKEN check. /api/reports authenticates itself with a per-repo token.
const PUBLIC_PATHS = new Set(["/webhooks/github", "/health", "/api/reports"]);

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    throw new Error("API_TOKEN is not set");
  }

  fastify.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path)) {
      return;
    }
    const header = request.headers.authorization;
    if (header !== `Bearer ${apiToken}`) {
      return reply.code(401).send(errorBody("unauthorized", "Missing or invalid API token", request.id));
    }
  });
};

export default fp(authPlugin);
