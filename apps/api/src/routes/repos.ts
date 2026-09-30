import type { FastifyPluginAsync } from "fastify";
import { repos } from "../db/schema.js";

const reposRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/repos", async () => {
    return fastify.db.select().from(repos);
  });
};

export default reposRoute;
