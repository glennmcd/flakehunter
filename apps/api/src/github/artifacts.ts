import type { GithubClient } from "./client.js";

export interface RunArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
}

export async function listRunArtifacts(
  client: GithubClient,
  params: { owner: string; repo: string; runId: number },
): Promise<RunArtifact[]> {
  const { data } = await client.rest.actions.listWorkflowRunArtifacts({
    owner: params.owner,
    repo: params.repo,
    run_id: params.runId,
  });
  return data.artifacts.map((a) => ({
    id: a.id,
    name: a.name,
    sizeInBytes: a.size_in_bytes,
  }));
}

export async function downloadArtifactZip(
  client: GithubClient,
  params: { owner: string; repo: string; artifactId: number },
): Promise<ArrayBuffer> {
  const response = await client.rest.actions.downloadArtifact({
    owner: params.owner,
    repo: params.repo,
    artifact_id: params.artifactId,
    archive_format: "zip",
  });
  return response.data as ArrayBuffer;
}
