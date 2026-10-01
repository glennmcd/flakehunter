import path from "node:path";
import { runTunnel } from "./tunnel/runTunnel.js";

// Starts a cloudflared quick tunnel to the local API, passes its output through, and writes the GitHub webhook
// URL (<tunnel url>/webhooks/github) to scripts/webhook-url.txt, overwriting it each run. The file is git-ignored.
//
//   bun run tunnel                       # tunnels http://localhost:3000
//   bun run tunnel http://localhost:4000 # tunnels another target

const target = process.argv[2] ?? "http://localhost:3000";
const file = path.join(import.meta.dir, "webhook-url.txt");

try {
  const exitCode = await runTunnel({
    cmd: ["cloudflared", "tunnel", "--url", target],
    file,
    onUrl: (url) => process.stderr.write(`\n[tunnel] webhook URL: ${url}\n[tunnel] written to ${file}\n\n`),
  });
  process.exit(exitCode);
} catch (err) {
  console.error(
    `Could not run cloudflared (is it installed and on PATH?): ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}
