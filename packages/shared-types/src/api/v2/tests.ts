import { z } from "zod";
import { REPO_HOSTS, type RepoHost } from "../../domain";
import { pageSchema, paginationQuerySchema, testStatusSchema } from "../common";
import { ciSourceSchema } from "./common";

const PATH = /^[^/\s:]+(\/[^/\s:]+)+$/;

/**
 * A `repo` query value: a numeric id, or a path of two or more `/`-separated segments (`acme/widgets`,
 * `group/sub/project`), optionally prefixed with its host (`github:acme/widgets`).
 */
export const repoRefSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    if (/^\d+$/.test(value)) return { id: Number(value) } as { id: number; fullName?: undefined; host?: undefined };
    const qualified = /^([^:]+):(.*)$/.exec(value);
    const host = qualified?.[1];
    const path = qualified ? (qualified[2] ?? "") : value;
    if (host !== undefined && !(REPO_HOSTS as readonly string[]).includes(host)) {
      ctx.addIssue({ code: "custom", message: `unknown host "${host}"; expected one of ${REPO_HOSTS.join(", ")}` });
      return z.NEVER;
    }
    if (PATH.test(path)) {
      return { fullName: path, host: host as RepoHost | undefined } as {
        id?: undefined;
        fullName: string;
        host?: RepoHost;
      };
    }
    ctx.addIssue({
      code: "custom",
      message: "must be a numeric repo id or a path such as owner/name, optionally host:path",
    });
    return z.NEVER;
  });

export const flakyTestsQuerySchema = paginationQuerySchema.extend({
  repo: repoRefSchema,
  since: z.iso.datetime({ offset: true }).optional(),
  minRuns: z.coerce.number().int().min(1).default(5),
});

const runSchema = z.object({
  id: z.number().int(),
  ciRunId: z.number().int(),
  ciSource: ciSourceSchema,
  attempt: z.number().int(),
  workflowName: z.string(),
  htmlUrl: z.string().nullable(),
});

const testSchema = z.object({
  id: z.number().int(),
  repoId: z.number().int(),
  classname: z.string(),
  name: z.string(),
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
  run: runSchema,
});

export const testFailureItemSchema = z.object({
  resultId: z.number().int(),
  status: z.enum(["failed", "error"]),
  headSha: z.string(),
  headBranch: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
  run: runSchema,
});

export const testHistoryResponseSchema = z.object({
  test: testSchema,
  data: z.array(testHistoryItemSchema),
  page: pageSchema,
});
export type TestHistoryResponse = z.infer<typeof testHistoryResponseSchema>;

export const testFailuresResponseSchema = z.object({ test: testSchema, data: z.array(testFailureItemSchema) });
export type TestFailuresResponse = z.infer<typeof testFailuresResponseSchema>;
