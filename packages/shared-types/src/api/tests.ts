import { z } from "zod";
import { pageSchema, paginationQuerySchema, testStatusSchema } from "./common";

export const repoRefSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    if (/^\d+$/.test(value)) return { id: Number(value) } as { id: number; fullName?: undefined };
    if (/^[^/\s]+\/[^/\s]+$/.test(value)) return { fullName: value } as { id?: undefined; fullName: string };
    ctx.addIssue({ code: "custom", message: "must be a numeric repo id or owner/name" });
    return z.NEVER;
  });

const sinceSchema = z.iso.datetime({ offset: true }).optional();

export const flakyTestsQuerySchema = paginationQuerySchema.extend({
  repo: repoRefSchema,
  since: sinceSchema,
  minRuns: z.coerce.number().int().min(1).default(5),
});

export const flakyTestItemSchema = z.object({
  testId: z.number().int(),
  classname: z.string(),
  name: z.string(),
  shasRun: z.number().int(),
  flakyShas: z.number().int(),
  flakeRate: z.number(),
  lastFlakyAt: z.string(),
});
export type FlakyTestItem = z.infer<typeof flakyTestItemSchema>;

export const flakyTestsResponseSchema = z.object({ data: z.array(flakyTestItemSchema), page: pageSchema });

export const testHistoryQuerySchema = paginationQuerySchema.extend({
  since: sinceSchema,
  status: testStatusSchema.optional(),
});

export const testHistoryItemSchema = z.object({
  resultId: z.number().int(),
  status: testStatusSchema,
  headSha: z.string(),
  headBranch: z.string().nullable(),
  occurrenceIndex: z.number().int(),
  durationSeconds: z.number().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
  run: z.object({
    id: z.number().int(),
    githubRunId: z.number().int(),
    attempt: z.number().int(),
    workflowName: z.string(),
    htmlUrl: z.string().nullable(),
  }),
});

export const testFailureItemSchema = z.object({
  resultId: z.number().int(),
  status: z.enum(["failed", "error"]),
  headSha: z.string(),
  headBranch: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
  run: testHistoryItemSchema.shape.run,
});

export const testFailuresResponseSchema = z.object({
  test: z.object({ id: z.number().int(), repoId: z.number().int(), classname: z.string(), name: z.string() }),
  data: z.array(testFailureItemSchema),
});
export type TestFailuresResponse = z.infer<typeof testFailuresResponseSchema>;

export const testHistoryResponseSchema = z.object({
  test: z.object({ id: z.number().int(), repoId: z.number().int(), classname: z.string(), name: z.string() }),
  data: z.array(testHistoryItemSchema),
  page: pageSchema,
});
export type TestHistoryResponse = z.infer<typeof testHistoryResponseSchema>;
