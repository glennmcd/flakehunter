import { revokeRepoToken } from "../apps/api/src/auth/repoToken.js";
import { createDb } from "../apps/api/src/db/client.js";

// Only import from apps/api/src here: drizzle-orm is installed under apps/api, so a root-level script can't resolve it.
// Revoking is permanent and immediate: the token stops working on its next request. Revoking an unknown or already
// revoked token does nothing, so it is safe to run twice.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const token = process.env.REVOKE_TOKEN;
if (!token) {
  throw new Error("Set REVOKE_TOKEN to the upload token to revoke before running this script");
}

await revokeRepoToken(createDb(connectionString), token);

console.log("Revoked the token (if it existed). Mint a replacement with scripts/create-repo-token.ts.");
process.exit(0);
