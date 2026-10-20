// Writes (default) or checks (--check) docs/openapi.json (v1) and docs/openapi.v2.json, the committed OpenAPI documents
// generated from the routes.
import { readFileSync, writeFileSync } from "node:fs";
import { buildSpecTexts } from "../apps/api/src/openapi/buildSpec";

const files = { 1: "docs/openapi.json", 2: "docs/openapi.v2.json" } as const;
const specs = await buildSpecTexts();
const check = process.argv.includes("--check");

let stale = false;
for (const version of [1, 2] as const) {
  const name = files[version];
  const file = new URL(`../${name}`, import.meta.url);
  if (check) {
    let committed: string | null = null;
    try {
      committed = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    } catch {}
    if (committed !== specs[version]) {
      console.error(`${name} is out of date with the routes. Run \`bun run openapi:generate\` and commit it.`);
      stale = true;
    } else {
      console.log(`${name} is up to date.`);
    }
  } else {
    writeFileSync(file, specs[version]);
    console.log(`Wrote ${name}`);
  }
}
if (stale) process.exit(1);
