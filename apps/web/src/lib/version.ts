/** Commits are shown as their first 7 hex digits, the length git itself abbreviates to by default. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * "v0.0.1 · a1b2c3d": the dashboard's version and, when known, the commit it was built from. Returns null when there
 * is no version, so the caller renders nothing instead of a bare "v". A commit that is not a git hash is ignored
 * (Amplify or the environment could hand over anything), so only hex ever reaches the page.
 */
export function formatVersion(version: string | undefined, commit?: string): string | null {
  const v = version?.trim();
  if (!v) return null;
  const hash = commit?.trim();
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) return `v${v}`;
  return `v${v} · ${hash.slice(0, SHORT_COMMIT_LENGTH).toLowerCase()}`;
}

/**
 * The commit this build is from: Amplify's `AWS_COMMIT_ID` when it sets one (its build is a clone where git may not
 * work), else whatever `git rev-parse HEAD` says, else nothing. `runGit` is injected so tests need no repository.
 */
export function resolveCommit(
  env: Record<string, string | undefined>,
  runGit: () => string | undefined,
): string | undefined {
  const fromAmplify = env.AWS_COMMIT_ID?.trim();
  if (fromAmplify) return fromAmplify;
  try {
    return runGit()?.trim() || undefined;
  } catch {
    return undefined;
  }
}
