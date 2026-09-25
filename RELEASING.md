# Releasing

**A release is a pull request that bumps the version.** Merging it publishes the release.
Nothing else creates one, and no tag is ever made by hand.

1. In one pull request, change three files:
   - `manifest.json`: `version` to the new `x.y.z` (no `v`), and `minAppVersion` if the
     plugin now needs a newer Obsidian;
   - `versions.json`: add `"x.y.z": "<minAppVersion>"`;
   - `CHANGELOG.md`: a `## x.y.z` section at the top, written for someone deciding whether
     to update. It becomes the release notes.
2. CI's `check` job runs `node tools/release.mjs check`, which says "this change releases
   x.y.z" or names what is wrong. Merge when it is green.
3. The merge's push runs two jobs:
   - `release-build` builds `main.js` and decides, with a read-only token;
   - `release-publish`, the only job with write access, installs and builds nothing. It
     attests `main.js` and `manifest.json` (GitHub build provenance), creates the tag `x.y.z`
     on the merge commit, and publishes the release with both files and the changelog
     section as notes.

**Code may run ahead of the latest release.** Changes to `src/` — including Dependabot's —
merge without a version bump and ship with the next one. `check` notes that `main.js`
differs from the latest release, and that is all. What may not change without a bump is
`manifest.json`: Obsidian reads it from `main`'s HEAD, so it must always equal the latest
release's.

## What the checks refuse

`tools/release.mjs` (tested in `tools/release.test.mjs`) refuses, on the pull request:

- a version that is not `x.y.z`, or not above every published release;
- `versions.json` not mapping the version to `minAppVersion`, not having it as its highest
  key, or naming a version that was never released (an older Obsidian would get a 404);
- a missing `CHANGELOG.md` section;
- a `manifest.json` that differs from the latest release's without a version bump, or that
  names an older version than the latest release (a reverted bump);
- **a pending release**: a version set by an earlier change whose release never finished
  (below);
- a tag with no release, or a published release missing a file. Those need a person.

`main` requires branches to be up to date before merging, so these run against the latest
releases, not the ones that existed when the pull request was opened.

## When a release does not finish

If `release-build` or `release-publish` fails or is cancelled after a version bump merged,
`main` announces a version with no release, and Obsidian's update check for it fails until
it exists. **Re-run the failed workflow run** from the Actions tab. It is safe to re-run:
`publish` deletes a draft a dead run left behind (nothing of a draft was ever public), and
the checks are the same ones that passed.

Until then, every later pull request's `check` refuses with "release x.y.z is pending": a
later change must not publish its own code under that version's notes. The first release is
the one exception, because no earlier run exists to re-run.

## Never

- **Never retag or replace a release.** A bad release is fixed with a higher version.
  Immutable releases are on for this repository, so GitHub refuses it anyway.
- **Never push a version bump without its release.** The pull request is the only path.

## Repository settings this relies on

- **Immutable releases**: on.
- **Rulesets**: `main` cannot be force-pushed or deleted, and needs `pins` and `check` from
  GitHub Actions on an up-to-date branch. Release tags (`*.*.*`) cannot be moved or deleted.
- **Actions**: the default token is read-only, and every action must be pinned by commit.
  Only `release-publish`, on a push to `main`, asks for `contents: write`,
  `id-token: write` and `attestations: write`.
