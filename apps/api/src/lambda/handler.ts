import awsLambdaFastify from "@fastify/aws-lambda";
import type { Context } from "aws-lambda";
import type { FastifyInstance } from "fastify";

export interface HandlerDeps {
  /** Secrets to put in the environment before the app is built (SSM on Lambda). */
  loadSecrets: () => Promise<Record<string, string>>;
  buildApp: () => Promise<FastifyInstance>;
  /** Where the secrets are applied; defaults to process.env, which the plugins read when they register. */
  env?: Record<string, string | undefined>;
}

/**
 * Builds the Lambda handler. The Fastify app is created once per execution environment, on the first invocation, and
 * reused while the environment stays warm (so the database connection is too). A failed start is not cached: the
 * next invocation tries again instead of keeping a broken environment.
 */
export function createHandler(deps: HandlerDeps) {
  const env = deps.env ?? process.env;
  let ready: ReturnType<typeof start> | undefined;

  async function start() {
    // Secrets overwrite anything already in the environment: Parameter Store is the single source on Lambda.
    Object.assign(env, await deps.loadSecrets());
    const app = await deps.buildApp();
    // The adapter decorates the request, which Fastify only allows before the app is ready, so wrap first.
    const proxy = awsLambdaFastify(app, { callbackWaitsForEmptyEventLoop: false });
    await app.ready();
    return proxy;
  }

  return async (event: unknown, context: Context) => {
    ready ??= start().catch((error) => {
      ready = undefined;
      throw error;
    });
    return (await ready)(event, context);
  };
}
