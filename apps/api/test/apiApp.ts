import Fastify, { type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Db } from "../src/db/client.js";
import errorHandlerPlugin from "../src/plugins/errorHandler.js";
import type { TestDb } from "./testDb.js";

/**
 * Minimal app for route tests: zod compilers, the standard error handler and a PGlite db, with each route
 * plugin mounted under /api, as routes/index.ts does for routes/api/. The global Bearer auth hook is
 * intentionally not registered; it is covered in plugins/auth.test.ts.
 */
export async function buildApiApp(db: TestDb, routes: FastifyPluginAsync[]) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("db", db as unknown as Db);
  await app.register(errorHandlerPlugin);
  for (const route of routes) {
    await app.register(route, { prefix: "/api" });
  }
  return app;
}
