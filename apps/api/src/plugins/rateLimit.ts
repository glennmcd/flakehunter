import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { FastifyPluginAsync, onRequestAsyncHookHandler } from "fastify";
import fp from "fastify-plugin";
import { rateLimitHook, readRateLimitConfig } from "../ratelimit/limiter.js";
import { DynamoRateLimitStore, MemoryRateLimitStore, type RateLimitStore } from "../ratelimit/store.js";

declare module "fastify" {
  interface FastifyInstance {
    /** onRequest hook for POST /api/reports that counts uploads per token (or IP) and answers 429 over the limit. */
    uploadRateLimit: onRequestAsyncHookHandler;
  }
}

export interface RateLimitPluginOptions {
  store?: RateLimitStore;
  max?: number;
  windowSeconds?: number;
}

/**
 * Chooses the counter store: DynamoDB when RATE_LIMIT_TABLE is set, otherwise in memory. In memory is wrong on
 * Lambda (each concurrent invocation would count separately), so there a missing table is a startup error.
 */
const rateLimitPlugin: FastifyPluginAsync<RateLimitPluginOptions> = async (fastify, options) => {
  const env = process.env;
  const config = readRateLimitConfig(env);
  config.max = options.max ?? config.max;
  config.windowSeconds = options.windowSeconds ?? config.windowSeconds;

  let store = options.store;
  if (!store) {
    if (env.RATE_LIMIT_TABLE) {
      store = new DynamoRateLimitStore(new DynamoDBClient({}), env.RATE_LIMIT_TABLE);
    } else if (env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error("RATE_LIMIT_TABLE is not set; an in-memory rate limit does not work across Lambda instances");
    } else {
      store = new MemoryRateLimitStore();
    }
  }

  fastify.decorate("uploadRateLimit", rateLimitHook(store, config));
};

export default fp(rateLimitPlugin);
