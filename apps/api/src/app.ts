import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { CiSourceRegistry } from "./ci/registry.js";
import type { AnyDb, Db } from "./db/client.js";
import authPlugin from "./plugins/auth.js";
import ciSourcesPlugin from "./plugins/ciSources.js";
import dbPlugin from "./plugins/db.js";
import errorHandlerPlugin from "./plugins/errorHandler.js";
import openapiPlugin from "./plugins/openapi.js";
import rateLimitPlugin, { type RateLimitPluginOptions } from "./plugins/rateLimit.js";
import { registerRoutes } from "./routes/index.js";

export interface BuildAppOptions {
  /** Use this database instead of connecting to DATABASE_URL (tests pass a PGlite instance). */
  db?: AnyDb;
  logger?: boolean;
  /** Override the upload rate limit (tests); by default it comes from the environment. */
  rateLimit?: RateLimitPluginOptions;
  /** Use these CI adapters instead of the ones built from GITHUB_PAT (tests pass fakes). */
  ciSources?: CiSourceRegistry;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const fastify = Fastify({ logger: options.logger ?? true });

  // Routes without a zod schema (health, the webhook) are unaffected by these compilers.
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  await fastify.register(errorHandlerPlugin);
  if (options.db) {
    fastify.decorate("db", options.db as unknown as Db);
  } else {
    await fastify.register(dbPlugin);
  }
  await fastify.register(authPlugin);
  await fastify.register(ciSourcesPlugin, { registry: options.ciSources });
  await fastify.register(rateLimitPlugin, options.rateLimit ?? {});
  // Before the routes, so swagger sees them as they register.
  await fastify.register(openapiPlugin);
  await registerRoutes(fastify);

  return fastify;
}
