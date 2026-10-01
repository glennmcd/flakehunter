import type { RepoItem } from "@flakehunter/shared-types";
import Link from "next/link";

export function RepoList({ repos, total }: { repos: RepoItem[]; total: number }) {
  return (
    <main>
      <h1>Repositories</h1>
      {repos.length === 0 ? (
        <p className="empty">
          No repositories are registered yet. Add one with <code>scripts/seed-dev-repo.ts</code>, then upload a test
          report to see it here.
        </p>
      ) : (
        <>
          <ul className="repo-list">
            {repos.map((repo) => (
              <li key={repo.id}>
                <Link href={`/repos/${repo.id}`}>
                  <span className="test-name">{repo.name}</span>
                  <span className="test-class">{repo.owner}</span>
                </Link>
              </li>
            ))}
          </ul>
          {total > repos.length ? (
            <p className="pagination">
              Showing the first {repos.length} of {total} repositories.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
