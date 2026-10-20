import { z } from "zod";
import { reportCountsSchema, uploadReportHeadersSchema as v1UploadReportHeadersSchema } from "../reports";
import { ciSourceSchema } from "./common";

export const uploadReportHeadersSchema = v1UploadReportHeadersSchema.extend({
  /** The CI system that ran the tests. Defaults to the repository host's own CI (github_actions for GitHub). */
  "x-fh-ci-source": ciSourceSchema.optional(),
});

export type UploadReportHeaders = z.output<typeof uploadReportHeadersSchema>;

export const uploadReportResponseSchema = z.object({
  run: z.object({
    id: z.number().int(),
    ciRunId: z.number().int(),
    ciSource: ciSourceSchema,
    attempt: z.number().int(),
    headSha: z.string(),
  }),
  duplicate: z.boolean(),
  counts: reportCountsSchema,
});
export type UploadReportResponse = z.infer<typeof uploadReportResponseSchema>;
