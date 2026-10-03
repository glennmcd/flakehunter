export interface McpEnv {
  apiBaseUrl: string;
  apiToken: string;
}

/** Reads API_BASE_URL and API_TOKEN. Names the missing variables but never echoes values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): McpEnv {
  const problems: string[] = [];
  const apiToken = source.API_TOKEN;
  if (!apiToken) problems.push("API_TOKEN is required");

  const rawUrl = source.API_BASE_URL;
  let apiBaseUrl = "";
  if (!rawUrl) {
    problems.push("API_BASE_URL is required");
  } else {
    try {
      const { protocol } = new URL(rawUrl);
      if (protocol !== "http:" && protocol !== "https:") throw new Error();
      apiBaseUrl = rawUrl.replace(/\/+$/, "");
    } catch {
      problems.push("API_BASE_URL must be an http(s) URL");
    }
  }

  if (problems.length > 0 || !apiToken) throw new Error(`Invalid environment: ${problems.join("; ")}`);
  return { apiBaseUrl, apiToken };
}
