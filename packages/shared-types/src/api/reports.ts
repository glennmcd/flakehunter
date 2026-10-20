import { z } from "zod";

export const reportCountsSchema = z.object({
  suites: z.number().int(),
  tests: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  error: z.number().int(),
  skipped: z.number().int(),
});
