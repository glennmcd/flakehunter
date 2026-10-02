import { runMigrations } from "./migrator.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

await runMigrations(connectionString);

console.log("Migrations applied.");
