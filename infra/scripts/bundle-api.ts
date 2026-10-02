import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(infraRoot, "..");

export const DEFAULT_BUNDLE_DIR = path.join(infraRoot, "dist", "api");

/**
 * Bundles the API's Lambda entry point (apps/api/src/lambda.ts) into one ES module for the Node 22 Lambda runtime.
 * CDK's own NodejsFunction bundler is not used: it shells out to the package manager, which does not work with Bun on
 * Windows, and building the bundle here keeps it testable on its own (see test/bundle.test.ts).
 */
export async function bundleApi(outDir: string = DEFAULT_BUNDLE_DIR): Promise<string> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "index.mjs");

  await build({
    entryPoints: [path.join(repoRoot, "apps/api/src/lambda.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    // The Node 22 Lambda runtime ships the AWS SDK v3, so it stays out of the bundle.
    external: ["@aws-sdk/*"],
    // Some bundled CommonJS dependencies (fastify, pino) call require(); give the ESM bundle one.
    banner: {
      js: "import{createRequire as __fhCreateRequire}from'module';const require=__fhCreateRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  return outfile;
}

// Runs under Node (via tsx) as well as Bun, so the main-module check cannot use Bun's import.meta.main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outfile = await bundleApi();
  console.log(`Bundled the API Lambda to ${outfile}`);
}
