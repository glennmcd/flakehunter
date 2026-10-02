import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleApi } from "../scripts/bundle-api.js";

const apiNodeModules = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../apps/api/node_modules");

// The real bundle, built with the same code `cdk synth` runs. Lambda has no Bun, so it must load under plain Node.

describe("bundleApi", () => {
  it("bundles the Lambda entry into one ES module that loads under Node and exports the handler", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fh-bundle-"));
    try {
      const outfile = await bundleApi(dir);
      expect(path.basename(outfile)).toBe("index.mjs");
      expect(existsSync(`${outfile}.map`)).toBe(true);
      expect(statSync(outfile).size).toBeGreaterThan(100_000);

      // The AWS SDK comes from the Lambda runtime, not from the bundle.
      const code = readFileSync(outfile, "utf8");
      expect(code).toContain("@aws-sdk/client-ssm");
      expect(code).not.toContain("GetParametersCommand extends");

      // On Lambda the AWS SDK is provided by the runtime; here, point at the API's installed copy to stand in for it.
      symlinkSync(apiNodeModules, path.join(dir, "node_modules"), "junction");

      // Import and call it in a real Node process. With no SSM_PARAMETER_PREFIX the handler fails fast with a clear
      // message, which shows the bundle loaded (routes, fastify, drizzle, zod all resolved) and the handler is wired.
      const script = `
        const m = await import(${JSON.stringify(`file://${outfile.replaceAll("\\", "/")}`)});
        console.log("exports:" + Object.keys(m).join(","));
        try { await m.handler({}, {}); } catch (e) { console.log("error:" + e.message); }
      `;
      const result = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
        env: { PATH: process.env.PATH ?? "" },
      });
      const out = result.stdout.toString();
      expect(result.stderr.toString()).toBe("");
      expect(out).toContain("exports:handler");
      expect(out).toContain("error:SSM_PARAMETER_PREFIX is not set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
