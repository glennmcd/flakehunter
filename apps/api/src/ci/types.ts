import type { CiSource, RepoHost } from "@flakehunter/shared-types";

// Re-exported for the root scripts, which cannot resolve workspace packages themselves.
export { REPO_HOSTS } from "@flakehunter/shared-types";
export type { CiSource, RepoHost };

/** A registered repository, as a CI adapter needs it. Owner and name come from the `repos` row, never a payload. */
export interface CiRepo {
  /** `repos.id`. */
  id: number;
  host: RepoHost;
  externalRepoId: number;
  owner: string;
  name: string;
}

export interface ReportArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  /** Expired artifacts are still listed but can no longer be downloaded. */
  expired: boolean;
}

/** Fetches a run's artifacts from one CI system. Everything CI-specific on the ingestion path goes through this. */
export interface CiSourceAdapter {
  readonly ciSource: CiSource;
  /** Hosts whose repositories this CI system can build and this adapter can fetch for. */
  readonly hosts: ReadonlySet<RepoHost>;
  listRunArtifacts(repo: CiRepo, runId: number): Promise<ReportArtifact[]>;
  /** Downloads an artifact zip, refusing a body over `maxBytes` with ArtifactRejectedError. */
  downloadArtifact(repo: CiRepo, artifactId: number, maxBytes: number): Promise<Uint8Array>;
}
