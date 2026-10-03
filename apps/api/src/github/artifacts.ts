import { ArtifactRejectedError } from "../ingest/limits.js";
import type { GithubClient } from "./client.js";

export interface RunArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  /** Expired artifacts are still listed but can no longer be downloaded. */
  expired: boolean;
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
    expired: a.expired,
  }));
}

/**
 * Downloads an artifact zip and refuses a body over `maxBytes`. Octokit buffers the whole response first, so this
 * check does not bound memory; the caller's check of the listed size before downloading is what does.
 */
export async function downloadArtifactZip(
  client: GithubClient,
  params: { owner: string; repo: string; artifactId: number; maxBytes: number },
): Promise<ArrayBuffer> {
  const response = await client.rest.actions.downloadArtifact({
    owner: params.owner,
    repo: params.repo,
    artifact_id: params.artifactId,
    archive_format: "zip",
  });
  const data: unknown = response.data;
  if (!(data instanceof ArrayBuffer)) {
    throw new ArtifactRejectedError("artifact download was not binary data");
  }
  if (data.byteLength > params.maxBytes) {
    throw new ArtifactRejectedError(`artifact download exceeds ${params.maxBytes} bytes`);
  }
  return data;
}
