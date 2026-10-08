import { createTestDb } from "../../test/testDb.js";
import { buildApp } from "../app.js";

/**
 * Builds the app over an empty in-memory database and returns its OpenAPI document as text, pretty-printed with a
 * trailing newline. This is what docs/openapi.json holds; scripts/openapi.ts writes or checks it.
 */
export async function buildSpecText(): Promise<string> {
  // Auth and the GitHub client read these when the app is built; the values never reach the spec.
  const env = { API_TOKEN: "spec", GITHUB_PAT: "spec", GITHUB_WEBHOOK_SECRET: "spec" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const { db, close } = await createTestDb();
  const app = await buildApp({ db, logger: false });
  try {
    await app.ready();
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
    await close();
    process.env = saved;
  }
}
