# 0006: One read token, per-repo upload tokens

**Status:** Accepted (Part 2)

## Context

Reads come from trusted callers (the dashboard's server and the MCP server). Uploads come from CI in many
repositories, where a secret is more likely to leak.

## Decision

Reads use one global bearer token, `API_TOKEN`. Uploads use a token per repo: only its sha256 hash is stored, it can
be revoked, and the repo is taken from the token, never from the request. There are no user accounts or OAuth.

## Consequences

- A leaked CI secret can only write to its own repo, and revoking it takes effect on the next request.
- Tokens are minted and revoked with scripts (`scripts/create-repo-token.ts`, `scripts/revoke-repo-token.ts`); there
  is no management endpoint.
- The shared read token has no per-user audit trail and is rotated by hand, a gap listed in
  [SECURITY.md](../SECURITY.md).
