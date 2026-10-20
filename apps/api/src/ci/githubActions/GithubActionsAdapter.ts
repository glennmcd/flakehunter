import type { CiRepo, CiSourceAdapter, RepoHost, ReportArtifact } from "../types.js";
import { downloadArtifactZip, listRunArtifacts } from "./artifacts.js";
import type { GithubClient } from "./client.js";

/** Fetches workflow run artifacts from GitHub Actions through the REST API. */
export class GithubActionsAdapter implements CiSourceAdapter {
  readonly ciSource = "github_actions" as const;
  readonly hosts: ReadonlySet<RepoHost> = new Set<RepoHost>(["github"]);

  constructor(private readonly client: GithubClient) {}

  listRunArtifacts(repo: CiRepo, runId: number): Promise<ReportArtifact[]> {
    return listRunArtifacts(this.client, { owner: repo.owner, repo: repo.name, runId });
  }

  async downloadArtifact(repo: CiRepo, artifactId: number, maxBytes: number): Promise<Uint8Array> {
    const zip = await downloadArtifactZip(this.client, { owner: repo.owner, repo: repo.name, artifactId, maxBytes });
    return new Uint8Array(zip);
  }
}
