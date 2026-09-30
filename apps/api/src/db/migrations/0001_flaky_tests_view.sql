CREATE VIEW flaky_tests AS
SELECT
  tc.repo_id,
  tc.id AS test_case_id,
  tc.classname,
  tc.name,
  tr.head_sha,
  COUNT(*) FILTER (WHERE tr.status = 'passed') AS pass_count,
  COUNT(*) FILTER (WHERE tr.status IN ('failed','error')) AS fail_count,
  MAX(tr.created_at) AS last_seen_at
FROM test_results tr
JOIN test_cases tc ON tc.id = tr.test_case_id
GROUP BY tc.repo_id, tc.id, tc.classname, tc.name, tr.head_sha
HAVING COUNT(*) FILTER (WHERE tr.status = 'passed') > 0
   AND COUNT(*) FILTER (WHERE tr.status IN ('failed','error')) > 0;
