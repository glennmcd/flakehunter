import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AnyDb, Db } from "./db/client.js";
import type { GithubClient } from "./github/client.js";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import githubPlugin from "./plugins/github.js";
import rateLimitPlugin, { type RateLimitPluginOptions } from "./plugins/rateLimit.js";
import { registerRoutes } from "./routes/index.js";

export interface BuildAppOptions {
  /** Use this database instead of connecting to DATABASE_URL (tests pass a PGlite instance). */
  db?: AnyDb;
  logger?: boolean;
  /** Override the upload rate limit (tests); by default it comes from the environment. */
  rateLimit?: RateLimitPluginOptions;
  /** Use this GitHub client instead of one built from GITHUB_PAT (tests pass a fake). */
  github?: GithubClient;
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
  await fastify.register(githubPlugin, { client: options.github });
  await fastify.register(rateLimitPlugin, options.rateLimit ?? {});
  await registerRoutes(fastify);

  return fastify;
}
