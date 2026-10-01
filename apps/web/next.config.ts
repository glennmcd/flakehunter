import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source (its "main" is src/index.ts), so Next has to compile it.
  transpilePackages: ["@flakehunter/shared-types"],
};

export default config;
