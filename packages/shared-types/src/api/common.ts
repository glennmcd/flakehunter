import { z } from "zod";

export const errorCodeSchema = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "payload_too_large",
  "invalid_report",
  "rate_limited",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  requestId: z.string(),
});
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pageSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const testStatusSchema = z.enum(["passed", "failed", "error", "skipped"]);

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
