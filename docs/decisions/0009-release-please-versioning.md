# 0009: Automated versions with release-please

**Status:** Accepted (Part 4)

## Context

The dashboard footer shows `v<version> · <commit>`, but the version in `apps/web/package.json` was bumped by hand and
nothing tagged or listed what changed. The repo already uses Conventional Commit messages and PR titles, there is a
single deployable unit, and the owner makes every commit, so a bot must not push to `main`.

## Decision

Use release-please (a GitHub Action, pinned to a commit) in manifest mode with **one version for the whole repository**.
It keeps a release PR open that bumps the version from commit types and writes `CHANGELOG.md`; merging that PR creates
the `vX.Y.Z` tag and a GitHub Release. The root `package.json` is the primary file, and `apps/web/package.json` is updated
as an extra file because the footer reads it. Considered and not chosen: semantic-release (publishes straight from `main`
without a PR to review), Changesets (aimed at publishing npm packages, needs a file in every PR) and a version taken from
`git describe` (no changelog, no meaningful number).

## Consequences

- Commit types now drive version numbers, so `feat:` and `fix:` must mean something. Documentation and tooling changes
  use `docs:`, `chore:` or `ci:`. Merge commits make a PR count twice (its own commits, and its title,
  which GitHub copies into the merge commit body), so PRs are squash-merged: the PR title is the one commit.
- Versions come in through a reviewable PR, so the owner still makes every merge. The release PR only runs CI when the
  workflow has a fine-grained token (`RELEASE_PLEASE_TOKEN`); that token is a standing credential to renew.
- A tag does not deploy anything: the API Lambda still changes only by `cdk deploy`, so a release says what is on `main`,
  not what is running.
- The other workspaces keep their own `0.0.1` and are not released separately.
- See [releasing.md](../releasing.md) for setup and rules.
