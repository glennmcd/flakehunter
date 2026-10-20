import { REPO_HOSTS, type RepoHost } from "../apps/api/src/ci/types.js";
import { createDb } from "../apps/api/src/db/client.js";
import { githubInstallations, repos } from "../apps/api/src/db/schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const host = process.env.SEED_REPO_HOST ?? "github";
const owner = process.env.SEED_REPO_OWNER;
const name = process.env.SEED_REPO_NAME;
// SEED_REPO_GITHUB_ID is the older name, still accepted.
const externalRepoId = process.env.SEED_REPO_EXTERNAL_ID ?? process.env.SEED_REPO_GITHUB_ID;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "dev-webhook-secret";

if (!(REPO_HOSTS as readonly string[]).includes(host)) {
  throw new Error(`SEED_REPO_HOST must be one of: ${REPO_HOSTS.join(", ")}`);
}
if (!owner || !name || !externalRepoId) {
  throw new Error(
    "Set SEED_REPO_OWNER, SEED_REPO_NAME and SEED_REPO_EXTERNAL_ID (the host's numeric repo id) before running this script",
  );
}

const db = createDb(connectionString);

await db
  .insert(repos)
  .values({
    host: host as RepoHost,
    externalRepoId: Number(externalRepoId),
    owner,
    name,
    fullName: `${owner}/${name}`,
  })
  .onConflictDoNothing();

// The installation row is what the GitHub webhook path needs; other hosts have no equivalent yet.
if (host === "github") {
  await db
    .insert(githubInstallations)
    .values({
      accountLogin: owner,
      webhookSecret,
    })
    .onConflictDoNothing();
}

console.log(`Seeded ${host} repo ${owner}/${name}`);
process.exit(0);
