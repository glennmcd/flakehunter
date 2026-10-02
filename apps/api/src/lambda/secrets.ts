import { GetParametersCommand } from "@aws-sdk/client-ssm";

/** The environment variables the API refuses to boot without; on Lambda they come from SSM Parameter Store. */
export const SECRET_NAMES = ["DATABASE_URL", "API_TOKEN", "GITHUB_PAT", "GITHUB_WEBHOOK_SECRET"] as const;

/** The slice of SSMClient this module uses, so tests can pass a plain fake. */
export interface SsmLike {
  send(command: GetParametersCommand): Promise<{
    Parameters?: { Name?: string; Value?: string }[];
    InvalidParameters?: string[];
  }>;
}

// GetParameters accepts at most 10 names per call.
const BATCH_SIZE = 10;

/**
 * Reads SecureString parameters named `<prefix><NAME>` (for example /flakehunter/demo/DATABASE_URL) and returns them
 * keyed by NAME. Fails with an error that names the missing or empty parameters, never their values.
 */
export async function loadSecrets(
  client: SsmLike,
  prefix: string,
  names: readonly string[] = SECRET_NAMES,
): Promise<Record<string, string>> {
  if (!prefix.startsWith("/")) throw new Error(`SSM parameter prefix must start with "/": got "${prefix}"`);
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;

  const secrets: Record<string, string> = {};
  const problems: string[] = [];

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const response = await client.send(
      new GetParametersCommand({ Names: batch.map((name) => `${base}${name}`), WithDecryption: true }),
    );
    for (const missing of response.InvalidParameters ?? []) problems.push(`${missing} (not found)`);
    for (const parameter of response.Parameters ?? []) {
      const name = parameter.Name?.startsWith(base) ? parameter.Name.slice(base.length) : parameter.Name;
      if (!name) continue;
      if (!parameter.Value) problems.push(`${base}${name} (empty)`);
      else secrets[name] = parameter.Value;
    }
  }

  // A name that was neither returned nor reported invalid would otherwise slip through unnoticed.
  for (const name of names) {
    if (!(name in secrets) && !problems.some((problem) => problem.startsWith(`${base}${name} `))) {
      problems.push(`${base}${name} (not returned)`);
    }
  }

  if (problems.length > 0) throw new Error(`Could not load secrets from SSM: ${problems.join(", ")}`);
  return secrets;
}
