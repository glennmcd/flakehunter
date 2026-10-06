# Architecture decision records

Short records of the decisions that shaped FlakeHunter: what was decided, why, and what it led to. The build parts
they came from are in [../plans/](../plans/README.md).

| ADR | Decision | Part |
| --- | --- | --- |
| [0001](0001-postgres-on-neon.md) | Postgres on Neon, PGlite for tests | 1 |
| [0002](0002-flaky-on-same-commit.md) | Flaky means a pass and a fail on the same commit | 1, 2 |
| [0003](0003-multi-repo-schema.md) | Multi-repo schema from day one | 1 |
| [0004](0004-full-webhook-flow-first.md) | Build the full webhook flow first | 1 |
| [0005](0005-upload-api-xml-and-headers.md) | Upload API takes raw XML with metadata in headers | 2 |
| [0006](0006-read-token-and-upload-tokens.md) | One read token, per-repo upload tokens | 2 |
| [0007](0007-host-on-aws.md) | Host on AWS, keep the database on Neon | 4 |
| [0008](0008-aws-scp.md) | SCP use in AWS | 4 |

## Adding one

Copy this template to `NNNN-short-title.md` with the next number, and add a row above. Keep it under about 25 lines.
To reverse a decision, write a new ADR and mark the old one "Superseded by NNNN" rather than editing it.

```markdown
# NNNN: Title

**Status:** Accepted (Part N)

## Context

The problem and the forces at play.

## Decision

What was decided.

## Consequences

What follows from it, good and bad.
```
