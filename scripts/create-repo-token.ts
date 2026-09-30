import { eq } from "drizzle-orm";
import { mintRepoToken } from "../apps/api/src/auth/repoToken.js";
import { createDb } from "../apps/api/src/db/client.js";
import { repos } from "../apps/api/src/db/schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const fullName = process.env.TOKEN_REPO_FULL_NAME;
if (!fullName) {
  throw new Error("Set TOKEN_REPO_FULL_NAME (e.g. owner/name) before running this script");
}

const db = createDb(connectionString);

const [repo] = await db.select({ id: repos.id }).from(repos).where(eq(repos.fullName, fullName));
if (!repo) {
  throw new Error(`No repo registered as ${fullName}; run scripts/seed-dev-repo.ts first`);
}

const { token, prefix } = await mintRepoToken(db, repo.id);

console.log(`Created upload token ${prefix}... for ${fullName}. It is shown once; store it as a CI secret:\n`);
console.log(token);
process.exit(0);
