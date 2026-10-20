import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createGithubClient } from "../ci/githubActions/client.js";
import { GithubActionsAdapter } from "../ci/githubActions/GithubActionsAdapter.js";
import { CiSourceRegistry } from "../ci/registry.js";

declare module "fastify" {
  interface FastifyInstance {
    ciSources: CiSourceRegistry;
  }
}

export interface CiSourcesPluginOptions {
  /** Use this registry instead of one built from GITHUB_PAT (tests pass fake adapters). */
  registry?: CiSourceRegistry;
}

const ciSourcesPlugin: FastifyPluginAsync<CiSourcesPluginOptions> = async (fastify, options) => {
  if (options.registry) {
    fastify.decorate("ciSources", options.registry);
    return;
  }
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    throw new Error("GITHUB_PAT is not set");
  }
  fastify.decorate("ciSources", new CiSourceRegistry([new GithubActionsAdapter(createGithubClient(pat))]));
};

export default fp(ciSourcesPlugin);
