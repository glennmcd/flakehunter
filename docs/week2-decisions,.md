JUnit XML carries no commit SHA, run id, or attempt, but flaky detection needs the SHA and idempotency needs the run id. How should POST /api/reports receive them?

Raw XML body + headers (Recommended)

When the same repo + CI run id is uploaded again, what should happen? (Note: the existing webhook path has no such guard today, so a redelivered webhook re-inserts test_results and double counts.)

No-op, return 200 (Recommended)

How should 'flake rate' be defined for ranking? The current view only marks a (test, SHA) pair as flaky when it has both a pass and a fail on that SHA.

Flaky SHAs / SHAs run (Recommended)

How should read endpoints be authenticated and repos addressed? Today all routes use one global Bearer API_TOKEN, and routes live at /repos/... with no /api prefix (the Vite proxy handles /api).

Global token for reads, per-repo for POST (Recommended)