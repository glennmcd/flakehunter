import { uploadReportHeadersSchema, uploadReportResponseSchema } from "@flakehunter/shared-types";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponses } from "../../api/errorResponses.js";
import { ApiError } from "../../api/errors.js";
import { findRepoByToken } from "../../auth/repoToken.js";
import { gzipPreParsing } from "../../http/gzipBody.js";
import { ingestReport } from "../../ingest/ingestReport.js";
import { MAX_REPORT_BYTES } from "../../ingest/limits.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the per-repo token check on /api/reports. */
    repo?: { id: number; fullName: string };
  }
}

const reportsRoute: FastifyPluginAsync = async (fastify) => {
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
        description:
          "Authenticated with a per-repository upload token (not the read token); the repository comes from the token. Idempotent on (run id, attempt, report key): the first upload returns 201, a repeat returns 200 with the original counts. A SHA that contradicts an existing run is a 400. Unparseable bodies or reports with no testsuite are 422 (invalid_report) and store nothing. Rate limited per IP and per token (429 with Retry-After).",
        security: [{ uploadToken: [] }],
        headers: uploadReportHeadersSchema,
        response: {
          200: uploadReportResponseSchema.describe("Duplicate upload; counts are those of the original."),
          201: uploadReportResponseSchema.describe("Report stored."),
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
      const result = await ingestReport(fastify.db, {
        repoId: repo.id,
        githubRunId: h["x-fh-run-id"],
        attempt: h["x-fh-run-attempt"],
        headSha: h["x-fh-sha"],
        headBranch: h["x-fh-branch"],
        workflowName: h["x-fh-workflow"],
        reportKey: h["x-fh-report-key"],
        xml: request.body,
        timestamp: h["x-fh-timestamp"] ? new Date(h["x-fh-timestamp"]) : undefined,
      });

      return reply.code(result.duplicate ? 200 : 201).send(result);
    },
  );
};

export default reportsRoute;
