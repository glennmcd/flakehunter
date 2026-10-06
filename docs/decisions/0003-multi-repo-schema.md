# 0003: Multi-repo schema from day one

**Status:** Accepted (Part 1)

## Context

The first version only had to serve one repository, but supporting more later would mean changing every table and
query that holds test data.

## Decision

Model repositories from the start: a `repos` table keyed on GitHub's numeric repo id, with runs, test cases and
results all scoped to a repo. Test identity is `classname + name` within a repo.

## Consequences

- No schema migration was needed when the demo repo and the test-fixture repo ran side by side.
- Every query filters by repo, and a repo row must exist before anything is ingested (`scripts/seed-dev-repo.ts`).
- Per-repo upload tokens ([0006](0006-read-token-and-upload-tokens.md)) fit this model directly.
