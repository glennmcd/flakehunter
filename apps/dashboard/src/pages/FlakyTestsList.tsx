import { useEffect, useState } from "react";

interface FlakyTest {
  repoId: number;
  testCaseId: number;
  classname: string;
  name: string;
  headSha: string;
  passCount: number;
  failCount: number;
  lastSeenAt: string;
}

const REPO_ID = 1;

export function FlakyTestsList() {
  const [tests, setTests] = useState<FlakyTest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/repos/${REPO_ID}/flaky-tests`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(setTests)
      .catch((err) => setError(String(err)));
  }, []);

  if (error) return <p>Failed to load flaky tests: {error}</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Classname</th>
          <th>Name</th>
          <th>SHA</th>
          <th>Pass</th>
          <th>Fail</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {tests.map((t) => (
          <tr key={`${t.testCaseId}-${t.headSha}`}>
            <td>{t.classname}</td>
            <td>{t.name}</td>
            <td>{t.headSha.slice(0, 8)}</td>
            <td>{t.passCount}</td>
            <td>{t.failCount}</td>
            <td>{t.lastSeenAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
