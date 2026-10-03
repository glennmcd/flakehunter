import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createGithubClient, type GithubClient } from "../github/client.js";

declare module "fastify" {
  interface FastifyInstance {
    github: GithubClient;
  }
}

export interface GithubPluginOptions {
  /** Use this client instead of one built from GITHUB_PAT (tests pass a fake). */
  client?: GithubClient;
}

const githubPlugin: FastifyPluginAsync<GithubPluginOptions> = async (fastify, options) => {
  if (options.client) {
    fastify.decorate("github", options.client);
    return;
  }
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    throw new Error("GITHUB_PAT is not set");
  }
  fastify.decorate("github", createGithubClient(pat));
};

export default fp(githubPlugin);
