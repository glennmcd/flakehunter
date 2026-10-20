import swagger from "@fastify/swagger";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { API_VERSIONS, type ApiVersion, apiPrefix, DOCS_URLS, SPEC_URLS } from "../api/version.js";
import { MAX_REPORT_BYTES } from "../ingest/limits.js";

/**
 * Version of each published contract (docs/openapi.v2.json), not of the app: release-please bumps the app version on
 * every release, which would make the committed spec stale each time. Bump the minor for compatible additions and the
 * patch for wording; a breaking change gets a new path prefix instead
 * (docs/decisions/0010-openapi-published-contract.md).
 * v2 is 2.1.0: 2.0.1 reworded descriptions when v1 was removed; 2.1.0 added the gitlab host and gitlab_ci CI source.
 */
export const API_CONTRACT_VERSIONS: Record<ApiVersion, string> = { 2: "2.1.0" };

const docsPage = (title: string, specUrl: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "${specUrl}", dom_id: "#ui" });
    </script>
  </body>
</html>
`;

type OpenApiDoc = {
  info?: Record<string, unknown>;
  paths?: Record<string, Record<string, Record<string, unknown>>>;
};

/** The API version a documented path belongs to (`/api/v2/...` is v2), or null for an unversioned path. */
function versionOfPath(path: string): ApiVersion | null {
  return API_VERSIONS.find((version) => path.startsWith(`${apiPrefix(version)}/`)) ?? null;
}

/**
 * One version's document, cut from the document of every route: only that version's paths and its contract version;
 * the components, tags and the rest are shared. Safe because the generated document inlines every schema, so no version
 * can point at another (plugins/openapi.test.ts checks there is no $ref). The input is not modified.
 */
export function specForVersion(document: object, version: ApiVersion): object {
  const full = document as OpenApiDoc;
  const paths = Object.fromEntries(
    Object.entries(full.paths ?? {}).filter(([path]) => versionOfPath(path) === version),
  );
  return {
    ...full,
    info: { ...full.info, version: API_CONTRACT_VERSIONS[version] },
    paths,
  };
}

/** The upload route takes a raw XML body, which has no zod schema, so its request body is described here. */
function describeReportsUpload(doc: OpenApiDoc, path: string): void {
  const post = doc.paths?.[path]?.post;
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
        version: API_CONTRACT_VERSIONS[2],
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
      for (const version of API_VERSIONS) {
        describeReportsUpload(document.openapiObject as unknown as OpenApiDoc, `${apiPrefix(version)}/reports`);
      }
      return document.openapiObject;
    },
  });

  for (const version of API_VERSIONS) {
    const page = docsPage(`FlakeHunter API v${version}`, SPEC_URLS[version]);
    fastify.get(SPEC_URLS[version], { schema: { hide: true } }, async () => specForVersion(fastify.swagger(), version));
    fastify.get(DOCS_URLS[version], { schema: { hide: true } }, async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(page),
    );
  }
  // /docs was v1's page; it now sends readers to the current version.
  fastify.get("/docs", { schema: { hide: true } }, async (_request, reply) => reply.redirect(DOCS_URLS[2]));
};

export default fp(openapiPlugin);
