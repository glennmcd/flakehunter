import path from "node:path";
import { fileURLToPath } from "node:url";
import autoload from "@fastify/autoload";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AnyDb, Db } from "./db/client.js";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import githubPlugin from "./plugins/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  /** Use this database instead of connecting to DATABASE_URL (tests pass a PGlite instance). */
  db?: AnyDb;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const fastify = Fastify({ logger: options.logger ?? true });

  // Routes without a zod schema (the week-1 routes) are unaffected by these compilers.
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  await fastify.register(errorHandlerPlugin);
  if (options.db) {
    fastify.decorate("db", options.db as unknown as Db);
  } else {
    await fastify.register(dbPlugin);
  }
  await fastify.register(authPlugin);
  await fastify.register(githubPlugin);
  await fastify.register(autoload, {
    dir: path.join(__dirname, "routes"),
    // Tests live next to the routes and must not be loaded as route plugins.
    ignorePattern: /\.test\.[cm]?[jt]s$/,
  });

  return fastify;
}
