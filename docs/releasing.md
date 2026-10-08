# Releasing

FlakeHunter's version number is not edited by hand. [release-please](https://github.com/googleapis/release-please)
reads the Conventional Commit messages on `main`, keeps one **release PR** open that bumps the version and writes
`CHANGELOG.md`, and tags the release when you merge it. The reasoning is in
[ADR 0009](decisions/0009-release-please-versioning.md).

## How a release happens

1. You merge PRs to `main` as usual.
2. The `release-please` workflow (`.github/workflows/release-please.yml`) opens or updates a PR titled
   `chore(main): release X.Y.Z`. It contains the new version and the changelog, nothing else.
3. When you want to release, review that PR and merge it. release-please then creates the tag `vX.Y.Z` and a GitHub Release.
4. Amplify rebuilds `main` as it does for any merge, and the dashboard footer shows `vX.Y.Z · <commit>`.

A release is a label on a commit. **Nothing is deployed by it.** The dashboard rebuilds itself on every push to `main`;
the API Lambda changes only when you run `cdk deploy FlakeHunterApi` ([deployment.md](deployment.md)), so a new tag does
not mean the API is running that code.

## What decides the next version

The commit **type** does. Choose it for what changes for people who use the deployed app, not for which files you touched.

| Commit | Effect while the version is 0.x | After 1.0.0 |
| --- | --- | --- |
| `fix:` | patch (0.1.0 → 0.1.1) | patch |
| `feat:` | minor (0.1.1 → 0.2.0) | minor |
| `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer | minor (breaking changes do not jump to 1.0.0 by themselves) | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `build:`, `style:` | no release on their own; normally left out of the changelog | same |

A documentation-only change is `docs:` however large it is, and a one-line bug fix is `fix:`. The existing history has
commits like `feat(docs): ...` that would each have caused a minor release; use `docs:` for those.

**Use squash merging.** Each PR then becomes one commit on `main` whose message is the PR title, which already follows
this format, so the changelog gets one clean line per PR. Merge commits (what PRs #1 to #7 used) do not work cleanly:
GitHub writes the PR title into the body of the merge commit, and release-please reads that as a second commit, so every
PR is listed **twice**: once for its own commit and once for its title. The first release PR (#8) showed exactly that. The
PR title also counts on its own, so a `feat:` title on a PR of `docs:` commits would still cause a minor release. To
switch, go to **Settings**, **General**, **Pull Requests** on GitHub: tick **Allow squash merging**, set its default
commit message to **Pull request title**, and untick **Allow merge commits** and **Allow rebase merging** (a rebase merge
keeps each commit's own message, so the PR title would stop being the one that counts). From then on the PR title is the message that
counts, so keep it in this format.

## One-time setup (you do this; it changes repository settings and creates a secret)

1. **Let Actions open PRs.** On GitHub: repository **Settings**, **Actions**, **General**, **Workflow permissions**, tick
   **Allow GitHub Actions to create and approve pull requests**. Without it the workflow fails when it tries to open the
   release PR.
2. **Recommended: a token so CI runs on the release PR.** Pull requests and tags made with the built-in `GITHUB_TOKEN` do
   not start other workflows, so `ci.yml` would never run on the release PR. Create a fine-grained personal access token
   (**Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**) with:
   - Repository access: **Only select repositories**, this one.
   - Repository permissions: **Contents** read and write, **Pull requests** read and write, **Issues** read and write
     (the Action labels the release PR). Metadata read is added for you.
   - An expiry date, and a reminder to renew the token before it passes.

   Then add it as a repository secret named `RELEASE_PLEASE_TOKEN` (**Settings**, **Secrets and variables**,
   **Actions**). The workflow falls back to the built-in token when the secret is missing, so skipping this step
   still works, with one difference: close and reopen the release PR to make CI run on it.

The token is used by one job, pinned to an exact commit of the Action, that runs only on pushes to `main`; it never runs
for pull requests from forks. `scripts/releaseConfig.test.ts` fails if the workflow stops being pinned, gains a shell
step or asks for more permissions.

## The first release

- `bootstrap-sha` in `release-please-config.json` makes the first changelog start after the commit the setup was made
  on, instead of listing every commit since the first one. Once the first release PR is merged the key is ignored; delete it
  whenever you like.
- The starting version, 0.0.2, is in `.release-please-manifest.json`. The first `feat:` after the setup makes it 0.1.0.
- To choose a version yourself, for example to declare 1.0.0, add a commit whose body ends with `Release-As: 1.0.0`:

  ```bash
  git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
  ```

## Rules

- **Never edit the version by hand** in `package.json`, `apps/web/package.json` or `.release-please-manifest.json`. The
  release PR changes all three together, and `scripts/releaseConfig.test.ts` fails if they disagree. The version is
  repository-wide: the API, dashboard and infra are released as one unit.
- `bun.lock` also records each workspace's version, but `bun install --frozen-lockfile` does not compare it with
  `package.json` (the lockfile already says `apps/web` 0.0.1 while the package says 0.0.2 and CI passes), so the release PR
  does not need to touch the lockfile.
- **Updating the Action.** Find the commit for a new release tag, check its inputs in its `action.yml`, and replace the
  commit and the `# vX.Y.Z` comment in the workflow:

  ```bash
  gh api repos/googleapis/release-please-action/git/ref/tags/<tag> --jq .object.sha
  ```
