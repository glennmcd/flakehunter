import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source (its "main" is src/index.ts), so Next has to compile it.
  transpilePackages: ["@flakehunter/shared-types"],
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this folder; the repo-root CLAUDE.md is the source.
  agentRules: false,
};

export default config;
