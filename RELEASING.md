# Releasing

**A release is a pull request that bumps the version.** Merging it publishes the release.
Nothing else creates one, and no tag is ever made by hand.

1. In one pull request, change three files:
   - `manifest.json`: `version` to the new `x.y.z` (no `v`), and `minAppVersion` if the
     plugin now needs a newer Obsidian;
   - `versions.json`: add `"x.y.z": "<minAppVersion>"`;
   - `CHANGELOG.md`: a `## x.y.z` section at the top, written for someone deciding whether
     to update. It becomes the release notes.
2. CI's `check` job runs `node tools/release.mjs check`, which says "merging this releases
   x.y.z" or names what is wrong. Merge when it is green.
3. The merge's push runs the `release` job. It builds `main.js`, attests `main.js` and
   `manifest.json` (GitHub build provenance), creates the tag `x.y.z` on the merge commit, and
   publishes the release with both files attached and the changelog section as notes.

Obsidian reads `manifest.json` at `main`'s HEAD and downloads the release whose tag matches
its `version`, so the merge and the release belong together: step 2 refuses in the pull
request whatever step 3 would otherwise refuse after the version is public.

## What the checks refuse

`tools/release.mjs` (tested in `tools/release.test.mjs`) refuses:

- a version that is not `x.y.z`, or not above every published release;
- `versions.json` not mapping the version to `minAppVersion`, not having it as its highest
  key, or naming a version that was never released (an older Obsidian would get a 404);
- a missing `CHANGELOG.md` section;
- **shipped files that changed while the version did not**: when the version is already
  released, the `main.js` and `manifest.json` built from the pull request must equal the
  published ones, or the pull request has to bump the version. A README or CI change passes;
- a tag with no release, or a published release missing a file. Those need a person.

A release job that died partway leaves a draft. The next run deletes it and publishes
again; nothing of a draft was ever public.

## Never

- **Never retag or replace a release.** A bad release is fixed with a higher version.
  Immutable releases are on for this repository, so GitHub refuses it anyway.
- **Never push a version bump without its release.** The pull request is the only path.

## Repository settings this relies on

- **Immutable releases**: on.
- **Rulesets**: `main` cannot be force-pushed or deleted and needs `pins` and `check`;
  release tags (`*.*.*`) cannot be moved or deleted.
- **Actions**: the default token is read-only, and every action is pinned by commit. Only
  the `release` job, on a push to `main`, asks for `contents: write`, `id-token: write`
  and `attestations: write`.
