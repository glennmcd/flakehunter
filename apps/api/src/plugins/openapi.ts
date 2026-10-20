import swagger from "@fastify/swagger";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import {
  API_VERSIONS,
  type ApiVersion,
  apiPrefix,
  DOCS_URLS,
  SPEC_URLS,
  V1_DEPRECATED_AT,
  V1_DEPRECATION_HEADERS,
} from "../api/version.js";
import { MAX_REPORT_BYTES } from "../ingest/limits.js";

/**
 * Version of each published contract (docs/openapi.json, docs/openapi.v2.json), not of the app: release-please bumps the
 * app version on every release, which would make the committed specs stale each time. Bump the minor for compatible
 * additions; a breaking change gets a new path prefix instead (see docs/decisions/0010-openapi-published-contract.md).
 * v1 is 1.1.0 because marking its operations deprecated is a compatible change.
 */
export const API_CONTRACT_VERSIONS: Record<ApiVersion, string> = { 1: "1.1.0", 2: "2.0.0" };

const docsPage = (title: string, specUrl: string, notice = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  </head>
  <body>
${notice}    <div id="ui"></div>
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

/** The API version a documented path belongs to: /api/v2/... is v2, any other /api/... is v1. */
function versionOfPath(path: string): ApiVersion | null {
  const v2 = apiPrefix(2);
  if (path === v2 || path.startsWith(`${v2}/`)) return 2;
  return path.startsWith(`${apiPrefix(1)}/`) ? 1 : null;
}

const V1_DEPRECATION_NOTE =
  `Deprecated since ${V1_DEPRECATED_AT.toISOString().slice(0, 10)}: use the same operation under ${apiPrefix(2)} ` +
  `(${SPEC_URLS[2]}, ${DOCS_URLS[2]}).`;

/** How the v1 deprecation headers appear on every v1 response in docs/openapi.json. */
const V1_RESPONSE_HEADERS = {
  Deprecation: {
    description: "RFC 9745: v1 is deprecated, since the given Unix time.",
    schema: { type: "string", const: V1_DEPRECATION_HEADERS.deprecation },
  },
  Link: {
    description: "The successor version (the v2 OpenAPI document) and the v2 docs page.",
    schema: { type: "string", const: V1_DEPRECATION_HEADERS.link },
  },
};

/** Every v1 operation marked deprecated, with a note pointing at v2 and the headers each response carries. */
function deprecateV1(paths: OpenApiDoc["paths"] & object): OpenApiDoc["paths"] {
  return Object.fromEntries(
    Object.entries(paths).map(([path, operations]) => [
      path,
      Object.fromEntries(
        Object.entries(operations).map(([method, op]) => {
          const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
          return [
            method,
            {
              ...op,
              description: op.description
                ? `${op.description}

${V1_DEPRECATION_NOTE}`
                : V1_DEPRECATION_NOTE,
              deprecated: true,
              responses: Object.fromEntries(
                Object.entries(responses).map(([status, response]) => [
                  status,
                  { ...response, headers: { ...(response.headers as object), ...V1_RESPONSE_HEADERS } },
                ]),
              ),
            },
          ];
        }),
      ),
    ]),
  );
}

/**
 * One version's document, cut from the document of every route: only that version's paths and its contract version;
 * the components, tags and the rest are shared. Safe because the generated document inlines every schema, so neither
 * half can point at the other (plugins/openapi.test.ts checks there is no $ref). v1's operations are marked deprecated.
 * The input is not modified.
 */
export function specForVersion(document: object, version: ApiVersion): object {
  const full = document as OpenApiDoc;
  const paths = Object.fromEntries(
    Object.entries(full.paths ?? {}).filter(([path]) => versionOfPath(path) === version),
  );
  return {
    ...full,
    info: { ...full.info, version: API_CONTRACT_VERSIONS[version] },
    paths: version === 1 ? deprecateV1(paths) : paths,
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

const V1_DOCS_NOTICE = `    <p role="note" style="font: 14px sans-serif; margin: 16px 20px">
      API v1 is deprecated. See <a href="${DOCS_URLS[2]}">API v2</a>.
    </p>
`;

const openapiPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "FlakeHunter API",
        version: API_CONTRACT_VERSIONS[1],
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
    const page =
      version === 1
        ? docsPage("FlakeHunter API", SPEC_URLS[1], V1_DOCS_NOTICE)
        : docsPage(`FlakeHunter API v${version}`, SPEC_URLS[version]);
    fastify.get(SPEC_URLS[version], { schema: { hide: true } }, async () => specForVersion(fastify.swagger(), version));
    fastify.get(DOCS_URLS[version], { schema: { hide: true } }, async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(page),
    );
  }
};

export default fp(openapiPlugin);
