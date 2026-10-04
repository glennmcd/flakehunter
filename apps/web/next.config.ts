import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { resolveCommit } from "./src/lib/version";

// The footer's version line. Read at build time and inlined, because the Amplify runtime does not see the build's
// environment. The version is this package's own; the commit is Amplify's AWS_COMMIT_ID or, locally, git's HEAD.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const commit = resolveCommit(process.env, () =>
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
);

const config: NextConfig = {
  reactStrictMode: true,
  // Not NEXT_PUBLIC_: nothing here is meant to be a browser setting. Neither value is secret, and both are inlined.
  env: { APP_VERSION: version, APP_COMMIT: commit ?? "" },
  // The shared package ships TypeScript source (its "main" is src/index.ts), so Next has to compile it.
  transpilePackages: ["@flakehunter/shared-types"],
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this folder; the repo-root CLAUDE.md is the source.
  agentRules: false,
};

export default config;
