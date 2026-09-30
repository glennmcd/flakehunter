import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { createDb, type Db } from "../db/client.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const db = createDb(connectionString);
  fastify.decorate("db", db);
};

export default fp(dbPlugin);
