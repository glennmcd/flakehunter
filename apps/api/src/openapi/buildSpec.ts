import { createTestDb } from "../../test/testDb.js";
import { API_VERSIONS, type ApiVersion } from "../api/version.js";
import { buildApp } from "../app.js";
import { specForVersion } from "../plugins/openapi.js";

/**
 * Builds the app over an empty in-memory database and returns each version's OpenAPI document as text, pretty-printed
 * with a trailing newline. This is what docs/openapi.v2.json holds; scripts/openapi.ts
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
    return Object.fromEntries(API_VERSIONS.map((version) => [version, text(version)])) as Record<ApiVersion, string>;
  } finally {
    await app.close();
    await close();
    process.env = saved;
  }
}
