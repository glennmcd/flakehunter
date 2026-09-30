import { Octokit } from "octokit";

export function createGithubClient(pat: string) {
  return new Octokit({ auth: pat });
}

export type GithubClient = ReturnType<typeof createGithubClient>;
