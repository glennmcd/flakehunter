import type postgres from "postgres";

type Env = Record<string, string | undefined>;

/** Neon's pooled endpoint has "-pooler" in the host name (PgBouncer in transaction mode). */
export function isPooledNeonUrl(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.split(".")[0]?.endsWith("-pooler") ?? false;
  } catch {
    return false;
  }
}

/**
 * postgres-js options for the environment the API runs in.
 *
 * On Lambda every concurrent invocation is its own execution environment holding its own pool, so a pool of one
 * connection per environment is plenty and keeps a burst of invocations from exhausting the database's connection
 * limit. An idle timeout lets a connection close while the environment sits warm, and a connect timeout keeps a
 * cold database from eating the whole invocation.
 *
 * A pooled Neon endpoint (PgBouncer, transaction mode) does not support prepared statements, so those are turned off.
 */
export function dbOptionsFor(
  connectionString: string,
  env: Env = process.env,
): postgres.Options<Record<string, never>> {
  const options: postgres.Options<Record<string, never>> = {};
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    options.max = 1;
    options.idle_timeout = 20;
    options.connect_timeout = 10;
  }
  if (isPooledNeonUrl(connectionString)) options.prepare = false;
  return options;
}
