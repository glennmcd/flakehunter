import { createDb } from "../apps/api/src/db/client.js";
import { githubInstallations, repos } from "../apps/api/src/db/schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const owner = process.env.SEED_REPO_OWNER;
const name = process.env.SEED_REPO_NAME;
const githubRepoId = process.env.SEED_REPO_GITHUB_ID;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "dev-webhook-secret";

if (!owner || !name || !githubRepoId) {
  throw new Error("Set SEED_REPO_OWNER, SEED_REPO_NAME, SEED_REPO_GITHUB_ID env vars before running this script");
}

const db = createDb(connectionString);

await db
  .insert(repos)
  .values({
    githubRepoId: Number(githubRepoId),
    owner,
    name,
    fullName: `${owner}/${name}`,
  })
  .onConflictDoNothing();

await db
  .insert(githubInstallations)
  .values({
    accountLogin: owner,
    webhookSecret,
  })
  .onConflictDoNothing();

console.log(`Seeded repo ${owner}/${name}`);
process.exit(0);
