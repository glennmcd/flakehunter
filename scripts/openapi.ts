// Writes (default) or checks (--check) docs/openapi.json, the committed OpenAPI document generated from the routes.
import { readFileSync, writeFileSync } from "node:fs";
import { buildSpecText } from "../apps/api/src/openapi/buildSpec";

const file = new URL("../docs/openapi.json", import.meta.url);
const spec = await buildSpecText();

if (process.argv.includes("--check")) {
  const committed = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  if (committed !== spec) {
    console.error("docs/openapi.json is out of date with the routes. Run `bun run openapi:generate` and commit it.");
    process.exit(1);
  }
  console.log("docs/openapi.json is up to date.");
} else {
  writeFileSync(file, spec);
  console.log("Wrote docs/openapi.json");
}
