import { ApiError } from "../apps/api/src/api/errors.js";
import { resolveRepo } from "../apps/api/src/api/resolveRepo.js";
import { mintRepoToken } from "../apps/api/src/auth/repoToken.js";
import { createDb } from "../apps/api/src/db/client.js";

// Only import from apps/api/src here: drizzle-orm is installed under apps/api, so a root-level script can't resolve it.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const fullName = process.env.TOKEN_REPO_FULL_NAME;
if (!fullName) {
  throw new Error("Set TOKEN_REPO_FULL_NAME (e.g. owner/name) before running this script");
}

const db = createDb(connectionString);

const repo = await resolveRepo(db, { fullName }).catch((err: unknown) => {
  if (err instanceof ApiError && err.code === "not_found") {
    throw new Error(`No repo registered as ${fullName}; run scripts/seed-dev-repo.ts first`);
  }
  throw err;
});

const { token, prefix } = await mintRepoToken(db, repo.id);

console.log(`Created upload token ${prefix}... for ${fullName}. It is shown once; store it as a CI secret:\n`);
console.log(token);
process.exit(0);
