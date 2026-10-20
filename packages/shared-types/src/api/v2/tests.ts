import { z } from "zod";
import { REPO_HOSTS, type RepoHost } from "../../domain";
import {
  flakyTestsQuerySchema as v1FlakyTestsQuerySchema,
  testFailureItemSchema as v1TestFailureItemSchema,
  testFailuresResponseSchema as v1TestFailuresResponseSchema,
  testHistoryItemSchema as v1TestHistoryItemSchema,
  testHistoryResponseSchema as v1TestHistoryResponseSchema,
} from "../tests";
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

export const flakyTestsQuerySchema = v1FlakyTestsQuerySchema.extend({ repo: repoRefSchema });

const runSchema = z.object({
  id: z.number().int(),
  ciRunId: z.number().int(),
  ciSource: ciSourceSchema,
  attempt: z.number().int(),
  workflowName: z.string(),
  htmlUrl: z.string().nullable(),
});

export const testHistoryItemSchema = v1TestHistoryItemSchema.extend({ run: runSchema });
export const testFailureItemSchema = v1TestFailureItemSchema.extend({ run: runSchema });

export const testHistoryResponseSchema = v1TestHistoryResponseSchema.extend({ data: z.array(testHistoryItemSchema) });
export type TestHistoryResponse = z.infer<typeof testHistoryResponseSchema>;

export const testFailuresResponseSchema = v1TestFailuresResponseSchema.extend({ data: z.array(testFailureItemSchema) });
export type TestFailuresResponse = z.infer<typeof testFailuresResponseSchema>;
