import { z } from "zod";

export const repoSummaryQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
});

export const repoSummaryResponseSchema = z.object({
  repo: z.object({ id: z.number().int(), fullName: z.string() }),
  window: z.object({ since: z.string() }),
  totals: z.object({
    runs: z.number().int(),
    tests: z.number().int(),
    results: z.number().int(),
    passRate: z.number().nullable(),
    flakyTests: z.number().int(),
    flakyShas: z.number().int(),
  }),
  lastRunAt: z.string().nullable(),
});
export type RepoSummaryResponse = z.infer<typeof repoSummaryResponseSchema>;
