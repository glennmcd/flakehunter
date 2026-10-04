import { describe, expect, it } from "bun:test";
import { formatVersion, resolveCommit } from "./version";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("formatVersion", () => {
  it("shows the version and the first 7 digits of the commit", () => {
    expect(formatVersion("0.0.1", SHA)).toBe("v0.0.1 · a1b2c3d");
  });

  it("shows only the version when there is no commit", () => {
    expect(formatVersion("0.0.1")).toBe("v0.0.1");
    expect(formatVersion("0.0.1", "")).toBe("v0.0.1");
    expect(formatVersion("0.0.1", "   ")).toBe("v0.0.1");
  });

  it("returns null without a version, so nothing is rendered", () => {
    expect(formatVersion(undefined, SHA)).toBeNull();
    expect(formatVersion("", SHA)).toBeNull();
    expect(formatVersion("  ", SHA)).toBeNull();
  });

  it("lowercases the commit and accepts a short one", () => {
    expect(formatVersion("1.2.3", "A1B2C3D")).toBe("v1.2.3 · a1b2c3d");
  });

  it("ignores a commit that is not a git hash, so only hex is ever shown", () => {
    expect(formatVersion("0.0.1", "<script>alert(1)</script>")).toBe("v0.0.1");
    expect(formatVersion("0.0.1", "not-a-hash")).toBe("v0.0.1");
    expect(formatVersion("0.0.1", "a1b2c3")).toBe("v0.0.1"); // too short to be unambiguous
  });
});

describe("resolveCommit", () => {
  const noGit = () => {
    throw new Error("git must not be called");
  };

  it("prefers Amplify's AWS_COMMIT_ID and does not call git", () => {
    expect(resolveCommit({ AWS_COMMIT_ID: SHA }, noGit)).toBe(SHA);
  });

  it("falls back to git when Amplify gives nothing", () => {
    expect(resolveCommit({}, () => `${SHA}\n`)).toBe(SHA);
    expect(resolveCommit({ AWS_COMMIT_ID: "  " }, () => SHA)).toBe(SHA);
  });

  it("returns nothing when git fails or prints nothing", () => {
    expect(
      resolveCommit({}, () => {
        throw new Error("not a git repository");
      }),
    ).toBeUndefined();
    expect(resolveCommit({}, () => "")).toBeUndefined();
    expect(resolveCommit({}, () => undefined)).toBeUndefined();
  });
});
