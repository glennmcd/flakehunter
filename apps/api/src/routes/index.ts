import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import flakyTestsRoute from "./api/flakyTests.js";
import reportsRoute from "./api/reports.js";
import repoSummaryRoute from "./api/repoSummary.js";
import apiReposRoute from "./api/repos.js";
import testFailuresRoute from "./api/testFailures.js";
import testHistoryRoute from "./api/testHistory.js";
import flakyRoute from "./flaky.js";
import healthRoute from "./health.js";
import reposRoute from "./repos.js";
import runsRoute from "./runs.js";
import testResultsRoute from "./tests.js";
import githubWebhookRoute from "./webhooks/github.js";

export interface RouteModule {
  /** Path of the route file under routes/, without extension. Checked against the directory by routes.test.ts. */
  file: string;
  plugin: FastifyPluginAsync;
  /** URL prefix the plugin is mounted under; the plugin itself registers the path after it. */
  prefix: string;
}

/**
 * Every route plugin, registered explicitly instead of with @fastify/autoload: autoload imports files from disk at
 * runtime, which a bundler (esbuild for Lambda) cannot see, so the routes would be missing from the bundle.
 * The prefixes are the ones autoload derived from the directory names: files in routes/api/ live under /api and
 * routes/webhooks/github.ts under /webhooks. Adding a route file means adding a line here; routes.test.ts fails if
 * one is forgotten.
 */
export const routeModules: RouteModule[] = [
  { file: "health", plugin: healthRoute, prefix: "" },
  { file: "flaky", plugin: flakyRoute, prefix: "" },
  { file: "repos", plugin: reposRoute, prefix: "" },
  { file: "runs", plugin: runsRoute, prefix: "" },
  { file: "tests", plugin: testResultsRoute, prefix: "" },
  { file: "api/flakyTests", plugin: flakyTestsRoute, prefix: "/api" },
  { file: "api/repoSummary", plugin: repoSummaryRoute, prefix: "/api" },
  { file: "api/reports", plugin: reportsRoute, prefix: "/api" },
  { file: "api/repos", plugin: apiReposRoute, prefix: "/api" },
  { file: "api/testFailures", plugin: testFailuresRoute, prefix: "/api" },
  { file: "api/testHistory", plugin: testHistoryRoute, prefix: "/api" },
  { file: "webhooks/github", plugin: githubWebhookRoute, prefix: "/webhooks" },
];

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  for (const { plugin, prefix } of routeModules) {
    await fastify.register(plugin, { prefix });
  }
}
