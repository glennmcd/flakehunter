import { z } from "zod";

export const uploadReportHeadersSchema = z.object({
  "x-fh-run-id": z.coerce.number().int().positive(),
  "x-fh-sha": z.string().regex(/^[0-9a-f]{40}$/i, "must be a 40-character hex commit SHA"),
  "x-fh-run-attempt": z.coerce.number().int().positive().default(1),
  "x-fh-branch": z.string().min(1).optional(),
  "x-fh-workflow": z.string().min(1).default("upload"),
  "x-fh-report-key": z.string().min(1).max(200).default("default"),
});

export const reportCountsSchema = z.object({
  suites: z.number().int(),
  tests: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  error: z.number().int(),
  skipped: z.number().int(),
});

export const uploadReportResponseSchema = z.object({
  run: z.object({
    id: z.number().int(),
    githubRunId: z.number().int(),
    attempt: z.number().int(),
    headSha: z.string(),
  }),
  duplicate: z.boolean(),
  counts: reportCountsSchema,
});
export type UploadReportResponse = z.infer<typeof uploadReportResponseSchema>;
