import { describe, expect, it } from "bun:test";
import { CiSourceRegistry } from "./registry.js";
import type { CiSource, CiSourceAdapter, RepoHost } from "./types.js";

function adapter(ciSource: CiSource): CiSourceAdapter {
  return {
    ciSource,
    hosts: new Set<RepoHost>(["github"]),
    listRunArtifacts: async () => [],
    downloadArtifact: async () => new Uint8Array(),
  };
}

describe("CiSourceRegistry", () => {
  it("returns the adapter registered for a CI source", () => {
    const githubActions = adapter("github_actions");

    expect(new CiSourceRegistry([githubActions]).get("github_actions")).toBe(githubActions);
  });

  it("rejects a CI source with no adapter", () => {
    expect(() => new CiSourceRegistry([]).get("github_actions")).toThrow(
      "no adapter registered for CI source github_actions",
    );
  });

  it("rejects two adapters for the same CI source", () => {
    expect(() => new CiSourceRegistry([adapter("github_actions"), adapter("github_actions")])).toThrow(
      "more than one adapter registered for CI source github_actions",
    );
  });
});
