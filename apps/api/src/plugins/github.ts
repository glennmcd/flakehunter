import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createGithubClient, type GithubClient } from "../github/client.js";

declare module "fastify" {
  interface FastifyInstance {
    github: GithubClient;
  }
}

const githubPlugin: FastifyPluginAsync = async (fastify) => {
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    throw new Error("GITHUB_PAT is not set");
  }
  fastify.decorate("github", createGithubClient(pat));
};

export default fp(githubPlugin);
