import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Driver-agnostic db type: matches both the postgres-js instance used at runtime and the
 * PGlite instance used in tests (see test/testDb.ts), since callers like processWorkflowRun
 * only rely on the common drizzle query-builder surface, not driver-specific behavior.
 */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
