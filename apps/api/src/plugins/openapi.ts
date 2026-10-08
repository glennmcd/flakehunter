import swagger from "@fastify/swagger";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { MAX_REPORT_BYTES } from "../ingest/limits.js";

/**
 * Version of the published contract (docs/openapi.json), not of the app: release-please bumps the app version on every
 * release, which would make the committed spec stale each time. Bump the minor for compatible additions; a breaking
 * change gets a new path prefix instead (see docs/decisions/0010-openapi-published-contract.md).
 */
export const API_CONTRACT_VERSION = "1.0.0";

const DOCS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FlakeHunter API</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });
    </script>
  </body>
</html>
`;

type OpenApiDoc = {
  paths?: Record<string, Record<string, Record<string, unknown>>>;
};

/** The upload route takes a raw XML body, which has no zod schema, so its request body is described here. */
function describeReportsUpload(doc: OpenApiDoc): void {
  const post = doc.paths?.["/api/reports"]?.post;
  if (!post) return;
  const xml = { schema: { type: "string", description: "A JUnit XML report (<testsuite> or <testsuites>)." } };
  post.requestBody = {
    required: true,
    description:
      `JUnit XML. Send it gzip-compressed with Content-Encoding: gzip for large reports (a Lambda request body is ` +
      `capped near 6 MB); the ${MAX_REPORT_BYTES}-byte limit applies to the decompressed size.`,
    content: { "application/xml": xml, "text/xml": xml },
  };
  const parameters = (post.parameters as Record<string, unknown>[] | undefined) ?? [];
  parameters.push({
    name: "content-encoding",
    in: "header",
    required: false,
    description: "Only `gzip` is accepted. Any other encoding is a 400.",
    schema: { type: "string", enum: ["gzip"] },
  });
  post.parameters = parameters;
}

const openapiPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "FlakeHunter API",
        version: API_CONTRACT_VERSION,
        description:
          "Ingests JUnit XML reports and reports flaky tests. A test is flaky on a commit when it has both a pass and a " +
          "fail (or error) on the same commit SHA. Every error uses the same body: `{ error: { code, message, details? }, " +
          "requestId }`. Lists take `?limit=&offset=` and return `{ data, page: { limit, offset, total } }`.",
      },
      tags: [
        { name: "reports", description: "Upload test reports from CI." },
        { name: "repos", description: "Repositories and their summaries." },
        { name: "tests", description: "Flaky-test ranking and per-test history." },
      ],
      components: {
        securitySchemes: {
          readToken: { type: "http", scheme: "bearer", description: "The read API token (`API_TOKEN`)." },
          uploadToken: {
            type: "http",
            scheme: "bearer",
            description: "A per-repository upload token. It identifies the repository; the request cannot name one.",
          },
        },
      },
      security: [{ readToken: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: (document) => {
      if (!("openapiObject" in document)) return document.swaggerObject;
      describeReportsUpload(document.openapiObject as unknown as OpenApiDoc);
      return document.openapiObject;
    },
  });

  fastify.get("/openapi.json", { schema: { hide: true } }, async () => fastify.swagger());
  fastify.get("/docs", { schema: { hide: true } }, async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(DOCS_PAGE),
  );
};

export default fp(openapiPlugin);
