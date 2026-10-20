import { describe, expect, it } from "bun:test";
import { ArtifactRejectedError } from "../../ingest/limits.js";
import type { CiRepo } from "../types.js";
import type { GithubClient } from "./client.js";
import { GithubActionsAdapter } from "./GithubActionsAdapter.js";

const REPO: CiRepo = { id: 1, host: "github", externalRepoId: 4242, owner: "acme", name: "widgets" };

/** An Octokit stand-in serving `data` for downloads; `calls` records each request's parameters. */
function fakeOctokit(data: unknown = new Uint8Array([1, 2, 3]).buffer) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    rest: {
      actions: {
        listWorkflowRunArtifacts: async (params: Record<string, unknown>) => {
          calls.push({ method: "list", params });
          return {
            data: {
              artifacts: [
                { id: 7, name: "junit", size_in_bytes: 123, expired: false, url: "ignored" },
                { id: 8, name: "old", size_in_bytes: 45, expired: true, url: "ignored" },
              ],
            },
          };
        },
        downloadArtifact: async (params: Record<string, unknown>) => {
          calls.push({ method: "download", params });
          return { data };
        },
      },
    },
  } as unknown as GithubClient;
  return { client, calls };
}

describe("GithubActionsAdapter", () => {
  it("is the github_actions adapter and fetches only for GitHub repositories", () => {
    const adapter = new GithubActionsAdapter(fakeOctokit().client);

    expect(adapter.ciSource).toBe("github_actions");
    expect([...adapter.hosts]).toEqual(["github"]);
  });

  it("lists a run's artifacts for the registered owner and name", async () => {
    const octokit = fakeOctokit();
    const adapter = new GithubActionsAdapter(octokit.client);

    const artifacts = await adapter.listRunArtifacts(REPO, 1001);

    expect(octokit.calls).toEqual([{ method: "list", params: { owner: "acme", repo: "widgets", run_id: 1001 } }]);
    expect(artifacts).toEqual([
      { id: 7, name: "junit", sizeInBytes: 123, expired: false },
      { id: 8, name: "old", sizeInBytes: 45, expired: true },
    ]);
  });

  it("downloads an artifact as a zip and returns its bytes", async () => {
    const octokit = fakeOctokit(new Uint8Array([1, 2, 3]).buffer);
    const adapter = new GithubActionsAdapter(octokit.client);

    const zip = await adapter.downloadArtifact(REPO, 7, 100);

    expect(octokit.calls).toEqual([
      { method: "download", params: { owner: "acme", repo: "widgets", artifact_id: 7, archive_format: "zip" } },
    ]);
    expect(zip).toBeInstanceOf(Uint8Array);
    expect([...zip]).toEqual([1, 2, 3]);
  });

  it("refuses a download larger than the limit", async () => {
    const adapter = new GithubActionsAdapter(fakeOctokit(new Uint8Array(101).buffer).client);

    const err = await adapter.downloadArtifact(REPO, 7, 100).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ArtifactRejectedError);
    expect((err as Error).message).toBe("artifact download exceeds 100 bytes");
  });

  it("refuses a download that is not binary data", async () => {
    const adapter = new GithubActionsAdapter(fakeOctokit("<html>not a zip</html>").client);

    const err = await adapter.downloadArtifact(REPO, 7, 100).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ArtifactRejectedError);
    expect((err as Error).message).toBe("artifact download was not binary data");
  });
});
