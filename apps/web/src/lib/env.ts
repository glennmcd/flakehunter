import { z } from "zod";

export interface WebEnv {
  /** Base URL of the FlakeHunter API, without a trailing slash. */
  apiBaseUrl: string;
  /** The API's global read token. Server-only: never import this from a client component. */
  apiToken: string;
  /** Password for the site-wide gate; unset means no gate (fine locally, refused in production by the proxy). */
  sitePassword: string | undefined;
}

export interface EnvProblem {
  variable: string;
  message: string;
}

/** Lists which variables are wrong and why. Values are deliberately left out so secrets never reach logs. */
export class EnvError extends Error {
  constructor(readonly problems: EnvProblem[]) {
    super(`Invalid environment: ${problems.map((p) => `${p.variable} ${p.message}`).join("; ")}`);
    this.name = "EnvError";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const requiredString = z.string({ error: "is required" }).min(1, "is required");

const schema = z.object({
  API_BASE_URL: requiredString.refine(isHttpUrl, "must be an http(s) URL"),
  API_TOKEN: requiredString,
  SITE_PASSWORD: z.string().optional(),
});

export function loadEnv(source: Record<string, string | undefined> = process.env): WebEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // One problem per variable (the first reported), so an empty value says "is required" and nothing else.
    const problems = new Map<string, EnvProblem>();
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? "environment");
      if (!problems.has(variable)) problems.set(variable, { variable, message: issue.message });
    }
    throw new EnvError([...problems.values()]);
  }

  return {
    apiBaseUrl: parsed.data.API_BASE_URL.replace(/\/+$/, ""),
    apiToken: parsed.data.API_TOKEN,
    sitePassword: parsed.data.SITE_PASSWORD || undefined,
  };
}
