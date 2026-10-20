import Fastify, { type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { type ApiRouteOptions, type ApiVersion, registerApiVersion } from "../src/api/version.js";
import type { Db } from "../src/db/client.js";
import errorHandlerPlugin from "../src/plugins/errorHandler.js";
import type { TestDb } from "./testDb.js";

/**
 * Minimal app for route tests: zod compilers, the standard error handler and a PGlite db, with each route
 * plugin mounted for one API version (v2 under /api/v2 by default) by registerApiVersion, as routes/index.ts
 * does. The global Bearer auth hook is intentionally not registered; it is covered in plugins/auth.test.ts.
 */
export async function buildApiApp(
  db: TestDb,
  routes: FastifyPluginAsync<ApiRouteOptions>[],
  apiVersion: ApiVersion = 2,
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("db", db as unknown as Db);
  await app.register(errorHandlerPlugin);
  await registerApiVersion(app, apiVersion, routes);
  return app;
}
