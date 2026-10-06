*Archived prompt, written as "week 2"; this is Part 2. Only the prompt was kept, not a full plan. Summary:
[../part-2-api.md](../part-2-api.md).*

Read docs/plans/week1.md and the current code. Plan the v1 REST API:
- POST /api/reports: upload a JUnit XML report. Auth with a per-repo API
  token. Idempotent on repo + CI run id, so re-uploads don't double count.
- GET /api/tests/flaky?repo=&since= : tests ranked by flake rate
- GET /api/tests/:id/history : pass/fail history for one test
- GET /api/repos/:id/summary : totals for the dashboard
Propose Zod request/response schemas, one error format, pagination and
status codes. Ask me about anything ambiguous before finalizing.