import { generateDemoRuns } from "./demo/generateRuns.js";
import { httpUploader, parseSeedConfig, SeedError, seedDemo } from "./demo/seedDemo.js";

// Generates a realistic fake CI history (stable tests, a few flaky ones, reruns) and uploads it through the real
// POST /api/reports endpoint, so a demo exercises the actual ingestion path. Re-running is safe: runs are
// deterministic for a seed, so repeats come back as 200 duplicates.
//
//   DEMO_UPLOAD_TOKEN=fh_... bun run seed:demo                       # local API on :3000, last 30 days
//   DEMO_UPLOAD_TOKEN=fh_... DEMO_API_URL=https://api.example.com bun run seed:demo
//   bun run seed:demo --dry-run                                      # generate and count, upload nothing
//
// Optional: DEMO_DAYS (0-365, default 30) and DEMO_SEED (default 42; a new seed makes a new history).

let config: ReturnType<typeof parseSeedConfig>;
try {
  config = parseSeedConfig(process.env, process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}

const runs = generateDemoRuns({ seed: config.seed, days: config.days, now: new Date() });
const reportCount = runs.reduce((sum, run) => sum + run.reports.length, 0);
const commits = new Set(runs.map((run) => run.headSha)).size;
console.log(
  `Generated ${runs.length} runs over ${commits} commits (${reportCount} report uploads) for the last ${config.days} days, seed ${config.seed}.`,
);

if (config.dryRun) {
  console.log("Dry run: nothing uploaded.");
  process.exit(0);
}

console.log(`Uploading to ${config.apiUrl}/api/reports ...`);
try {
  const summary = await seedDemo(runs, httpUploader(config.apiUrl, config.token), {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });
  console.log(
    `Done: ${summary.created} created, ${summary.duplicates} already present` +
      (summary.retries > 0 ? `, ${summary.retries} rate-limit retries` : "") +
      ".",
  );
} catch (err) {
  if (err instanceof SeedError) {
    console.error(err.message);
    if (err.status === 401) console.error("Check DEMO_UPLOAD_TOKEN: it must be an upload token for the demo repo.");
  } else {
    console.error(`Could not reach ${config.apiUrl}: ${err instanceof Error ? err.message : err}`);
  }
  process.exit(1);
}
