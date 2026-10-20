import { createTestDb } from "../../test/testDb.js";
import type { ApiVersion } from "../api/version.js";
import { buildApp } from "../app.js";
import { specForVersion } from "../plugins/openapi.js";

/**
 * Builds the app over an empty in-memory database and returns each version's OpenAPI document as text, pretty-printed
 * with a trailing newline. This is what docs/openapi.json (v1) and docs/openapi.v2.json hold; scripts/openapi.ts
 * writes or checks them.
 */
export async function buildSpecTexts(): Promise<Record<ApiVersion, string>> {
  // Auth and the GitHub client read these when the app is built; the values never reach the spec.
  const env = { API_TOKEN: "spec", GITHUB_PAT: "spec", GITHUB_WEBHOOK_SECRET: "spec" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const { db, close } = await createTestDb();
  const app = await buildApp({ db, logger: false });
  try {
    await app.ready();
    const full = app.swagger();
    const text = (version: ApiVersion) => `${JSON.stringify(specForVersion(full, version), null, 2)}\n`;
    return { 1: text(1), 2: text(2) };
  } finally {
    await app.close();
    await close();
    process.env = saved;
  }
}
