import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ApiError, errorBody } from "../api/errors.js";

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((err, request, reply) => {
    const requestId = request.id;

    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, requestId, err.details));
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const where = err.validationContext ?? "request";
      const details = err.validation.map((issue) => ({
        path: `${where}${issue.instancePath.replaceAll("/", ".")}`,
        message: issue.message ?? "invalid",
      }));
      return reply.code(400).send(errorBody("validation_error", "Request validation failed", requestId, details));
    }

    if ((err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(errorBody("payload_too_large", "Request body is too large", requestId));
    }

    // Remaining Fastify client errors (unsupported media type, malformed JSON, ...).
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(400).send(errorBody("validation_error", (err as Error).message, requestId));
    }

    request.log.error(err);
    return reply.code(500).send(errorBody("internal_error", "Internal server error", requestId));
  });
};

export default fp(errorHandlerPlugin);
