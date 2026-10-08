import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// release-please (docs/releasing.md) works from three files that must agree, and its workflow holds a token that can
// write to the repository. These tests catch a hand-edited version or a loosened workflow before a release goes wrong.

const root = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
interface PackageJson {
  version?: unknown;
}
interface ReleaseConfig {
  "bootstrap-sha": string;
  packages: Record<
    string,
    {
      "release-type": string;
      "include-component-in-tag": boolean;
      "extra-files": { type: string; path: string; jsonpath: string }[];
    }
  >;
}
const json = <T = PackageJson>(file: string) => JSON.parse(read(file)) as T;

const CONFIG = "release-please-config.json";
const MANIFEST = ".release-please-manifest.json";
const WORKFLOW = ".github/workflows/release-please.yml";

describe("release-please configuration", () => {
  it("tracks one version for the whole repository, released as a plain vX.Y.Z tag", () => {
    const config = json<ReleaseConfig>(CONFIG);
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(config.packages["."]?.["release-type"]).toBe("node");
    // With a component in the tag, releases would be named flakehunter-v1.2.3 instead of v1.2.3.
    expect(config.packages["."]?.["include-component-in-tag"]).toBe(false);
    expect(config["bootstrap-sha"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps the manifest, the root package.json and the dashboard's package.json on the same version", () => {
    const manifest = json<Record<string, string>>(MANIFEST);
    const rootVersion = json("package.json").version;
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest["."]).toBe(rootVersion);
    // The dashboard footer shows this one (apps/web/lib/version.ts), so a hand-bump here would show the wrong number.
    expect(json("apps/web/package.json").version).toBe(rootVersion);
  });

  it("updates the dashboard's package.json through the version field, and that file has one", () => {
    const extraFiles = json<ReleaseConfig>(CONFIG).packages["."]?.["extra-files"] ?? [];
    expect(extraFiles).toEqual([{ type: "json", path: "apps/web/package.json", jsonpath: "$.version" }]);
    for (const file of extraFiles) {
      expect(existsSync(path.join(root, file.path))).toBe(true);
      expect(typeof json(file.path).version).toBe("string");
    }
  });
});

describe("release-please workflow", () => {
  const workflow = Bun.YAML.parse(read(WORKFLOW)) as {
    on: { push?: { branches?: string[] }; [event: string]: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: { uses?: string; run?: string; with?: Record<string, string> }[] }>;
  };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

  it("runs only on pushes to main", () => {
    expect(Object.keys(workflow.on)).toEqual(["push"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
  });

  it("asks for exactly the three permissions the Action documents, and no more", () => {
    expect(workflow.permissions).toEqual({ contents: "write", issues: "write", "pull-requests": "write" });
  });

  it("runs the Action pinned to a commit, because a tag can be moved and this job can write to the repository", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => Boolean(u));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^googleapis\/release-please-action@[0-9a-f]{40}$/);
  });

  it("runs no shell commands, so no repository content or secret reaches a script", () => {
    expect(steps.some((s) => s.run !== undefined)).toBe(false);
  });

  it("points the Action at the config and manifest files that exist", () => {
    const inputs = steps.find((s) => s.uses)?.with ?? {};
    expect(inputs["config-file"]).toBe(CONFIG);
    expect(inputs["manifest-file"]).toBe(MANIFEST);
    for (const file of [CONFIG, MANIFEST]) expect(existsSync(path.join(root, file))).toBe(true);
  });

  it("falls back to the built-in token when the RELEASE_PLEASE_TOKEN secret is not set", () => {
    const token = steps.find((s) => s.uses)?.with?.token;
    expect(token).toMatch(/secrets.RELEASE_PLEASE_TOKEN || github.token/);
  });
});
