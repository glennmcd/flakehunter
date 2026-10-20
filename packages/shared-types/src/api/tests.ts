import { z } from "zod";
import { pageSchema, paginationQuerySchema, testStatusSchema } from "./common";

const sinceSchema = z.iso.datetime({ offset: true }).optional();

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
