import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dbOptionsFor } from "./options.js";

/** Resolved from this file, not the cwd, so the migration runs from any working directory (repo root, CI, a task). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Applies pending migrations. Prefer Neon's direct (non-pooled) connection string for this. */
export async function runMigrations(connectionString: string, migrationsFolder: string = MIGRATIONS_FOLDER) {
  const client = postgres(connectionString, { ...dbOptionsFor(connectionString, {}), max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
