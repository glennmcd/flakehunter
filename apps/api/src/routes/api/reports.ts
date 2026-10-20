import {
  DEFAULT_CI_SOURCE,
  type RepoHost,
  uploadReportHeadersSchema,
  uploadReportResponseSchema,
  v2,
} from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { ApiError } from "../../api/errors.js";
import { toV1Upload } from "../../api/v1.js";
import type { ApiRouteOptions, ApiVersion } from "../../api/version.js";
import { findRepoByToken } from "../../auth/repoToken.js";
import { gzipPreParsing } from "../../http/gzipBody.js";
import { ingestReport } from "../../ingest/ingestReport.js";
import { MAX_REPORT_BYTES } from "../../ingest/limits.js";

const IDEMPOTENCY: Record<ApiVersion, string> = {
  1: "Idempotent on (run id, attempt, report key): the first upload returns 201, a repeat returns 200 with the original counts.",
  2: "X-FH-CI-Source names the CI system that ran the tests and defaults to the host's own (github_actions for GitHub), so an upload without it is the same run as a v1 upload. Idempotent on (CI source, run id, attempt, report key): the first upload returns 201, a repeat returns 200 with the original counts.",
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the per-repo token check on /api/reports. */
    repo?: { id: number; host: RepoHost; fullName: string };
  }
}

const reportsRoute: FastifyPluginAsync<ApiRouteOptions> = async (fastify, { apiVersion }) => {
  const responseSchema = apiVersion === 1 ? uploadReportResponseSchema : v2.uploadReportResponseSchema;

  fastify.decorateRequest("repo", undefined);

  fastify.addContentTypeParser(
    ["application/xml", "text/xml"],
    { parseAs: "string", bodyLimit: MAX_REPORT_BYTES },
    (_request, body, done) => done(null, body),
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/reports",
    {
      bodyLimit: MAX_REPORT_BYTES,
      // Both run before body parsing and validation, so rejected callers never reach either. The rate limit comes
      // first so that a flood of bad tokens is stopped before it costs a database lookup each.
      onRequest: [
        ...(fastify.hasDecorator("uploadRateLimit") ? [fastify.uploadRateLimit] : []),
        async (request) => {
          const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
          const repo = match?.[1] ? await findRepoByToken(fastify.db, match[1]) : null;
          if (!repo) throw new ApiError("unauthorized", "Missing or invalid repo API token");
          request.repo = repo;
        },
      ],
      // Accepts Content-Encoding: gzip (the decompressed size is capped too); runs after the token check above.
      preParsing: gzipPreParsing(MAX_REPORT_BYTES),
      schema: {
        tags: ["reports"],
        summary: "Upload a JUnit XML report",
        description: `Authenticated with a per-repository upload token (not the read token); the repository comes from the token. ${IDEMPOTENCY[apiVersion]} A SHA that contradicts an existing run is a 400. Unparseable bodies or reports with no testsuite are 422 (invalid_report) and store nothing. Rate limited per IP and per token (429 with Retry-After).`,
        security: [{ uploadToken: [] }],
        headers: apiVersion === 1 ? uploadReportHeadersSchema : v2.uploadReportHeadersSchema,
        response: {
          200: responseSchema.describe("Duplicate upload; counts are those of the original."),
          201: responseSchema.describe("Report stored."),
          ...errorResponses(400, 401, 413, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const repo = request.repo;
      if (!repo) throw new ApiError("unauthorized", "Missing or invalid repo API token");

      // Only the XML parsers above (or text/plain) yield a string; anything else (e.g. JSON) is the wrong format.
      if (typeof request.body !== "string") {
        throw new ApiError("validation_error", "Content-Type must be application/xml or text/xml", [
          { path: "headers.content-type", message: "expected application/xml or text/xml" },
        ]);
      }

      const h = request.headers;
      // Only v2 has X-FH-CI-Source; v1 ignores the header if a client sends it.
      const namedCiSource = apiVersion === 1 ? undefined : (h as v2.UploadReportHeaders)["x-fh-ci-source"];
      const result = await ingestReport(fastify.db, {
        repoId: repo.id,
        // v1 has no way to name the CI source, and v2 may leave it out: either way the run is from the host's own CI.
        ciSource: namedCiSource ?? DEFAULT_CI_SOURCE[repo.host],
        runId: h["x-fh-run-id"],
        attempt: h["x-fh-run-attempt"],
        headSha: h["x-fh-sha"],
        headBranch: h["x-fh-branch"],
        workflowName: h["x-fh-workflow"],
        reportKey: h["x-fh-report-key"],
        xml: request.body,
        timestamp: h["x-fh-timestamp"] ? new Date(h["x-fh-timestamp"]) : undefined,
      });

      return reply.code(result.duplicate ? 200 : 201).send(apiVersion === 1 ? toV1Upload(result) : result);
    },
  );
};

export default reportsRoute;
