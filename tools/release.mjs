// Decides whether a push releases, and refuses the mistakes that would ship something wrong.
//
//   node tools/release.mjs check                  # every push and pull request (read-only)
//   node tools/release.mjs plan --notes <file>    # the release build, on a push to main (read-only)
//   node tools/release.mjs publish <version>      # the release publish job (write token)
//
// **A release is a pull request that bumps `manifest.json`'s `version`** (RELEASING.md). The
// merge's push reaches the release jobs, which tag that commit and publish `main.js` and
// `manifest.json`. Obsidian reads `manifest.json` at the default branch's HEAD and downloads
// `main.js` and `manifest.json` from the release whose tag equals its `version`. So HEAD's
// manifest must always name a released version whose `manifest.json` it matches, and the
// checks that can run before a merge run in `check`, on the pull request: a mistake is caught
// while it is a diff, not after it is public.
//
// `main.js` on `main` may run ahead of the latest release: code accumulates between releases
// and ships with the next version bump. Only the manifest is held to the release.
//
// `BASE_SHA` names the commit this change is measured against: a pull request's base, or the
// previous tip of `main` for a push. It is how an unreleased version is told apart from a
// release left pending by a failed run (see `decide`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The two files a release carries. The plugin ships no `styles.css`. */
export const ASSETS = ["main.js", "manifest.json"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Negative, zero or positive as `a` is below, equal to or above `b`. Both must be x.y.z. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not x.y.z: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The body of `## <version>` in a changelog, trimmed, or null when there is none. Headings
 * inside a fenced code block are not headings; CRLF line endings are accepted.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  const headings = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && line.startsWith("## ") ? line.slice(3).trim() : null;
  });
  const start = headings.indexOf(version);
  if (start < 0) return null;
  const next = headings.findIndex((h, i) => i > start && h !== null);
  const body = lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

/**
 * The decision, from facts alone.
 *
 * - `release`: this change carries a new version, and everything about it agrees.
 * - `released`: the version is the latest release; HEAD's `manifest.json` must equal the
 *   published one (the caller compares bytes).
 * - `none`: see `problems`.
 *
 * **A pending release is refused, not finished.** A version with no release yet may only be
 * released by the change that set it (`baseVersion` differs). If the base already carried it,
 * a release job failed or was cancelled after the bump merged; releasing it now would publish
 * later code under the old version's notes. The fix is to re-run that job. The one exception
 * is the first release, before any exists, which has no earlier run to re-run.
 *
 * @param {{
 *   manifest: {version: string, minAppVersion: string},
 *   versions: Record<string, string>,
 *   changelog: string,
 *   releases: {tag: string, draft: boolean, assets: string[]}[],
 *   tagExists: boolean,
 *   baseVersion: string | null,
 * }} facts
 * @returns {{problems: string[], action: "release" | "released" | "none",
 *   version: string, notes: string | null}}
 */
export function decide({ manifest, versions, changelog, releases, tagExists, baseVersion }) {
  const problems = [];
  const { version, minAppVersion } = manifest;
  let notes = null;
  const out = (action) => ({
    problems,
    action: problems.length > 0 ? "none" : action,
    version,
    notes,
  });

  if (!SEMVER.test(version)) {
    problems.push(`manifest.json's version "${version}" is not x.y.z (Obsidian's tags carry no v)`);
    return out("none");
  }
  const keys = Object.keys(versions);
  for (const key of keys) {
    if (!SEMVER.test(key)) problems.push(`versions.json key "${key}" is not x.y.z`);
  }
  if (versions[version] !== minAppVersion) {
    problems.push(
      `versions.json must map "${version}" to the manifest's minAppVersion "${minAppVersion}"`,
    );
  }
  const highestKey = keys
    .filter((k) => SEMVER.test(k))
    .sort(compareVersions)
    .at(-1);
  if (highestKey !== undefined && highestKey !== version) {
    problems.push(
      `versions.json's highest version is ${highestKey}, not the manifest's ${version}`,
    );
  }
  notes = changelogSection(changelog, version);
  if (notes === null) problems.push(`CHANGELOG.md has no non-empty "## ${version}" section`);

  // Drafts are ignored throughout: `check` and `plan` read with a read-only token, which
  // cannot see them, and a draft is never public. `publish` replaces one if it finds it.
  const published = releases.filter((r) => !r.draft);
  const highestPublished = published
    .map((r) => r.tag)
    .filter((t) => SEMVER.test(t))
    .sort(compareVersions)
    .at(-1);

  const existing = published.find((r) => r.tag === version);
  if (existing) {
    const missing = ASSETS.filter((a) => !existing.assets.includes(a));
    if (missing.length > 0) {
      problems.push(
        `release ${version} is published without ${missing.join(", ")}; needs a person`,
      );
    }
    if (version !== highestPublished) {
      problems.push(
        `manifest.json names ${version}, but ${highestPublished} is released: HEAD would ` +
          "advertise an older version. Was a version bump reverted?",
      );
    }
    return out("released");
  }

  if (tagExists) {
    problems.push(`tag ${version} exists with no release; needs a person, not a retry`);
  }
  if (highestPublished !== undefined && compareVersions(version, highestPublished) <= 0) {
    problems.push(`version ${version} must be above the highest release, ${highestPublished}`);
  }
  if (published.length > 0 && baseVersion === version) {
    problems.push(
      `release ${version} is pending: the version was set by an earlier change whose release ` +
        "did not finish. Re-run that commit's release job (RELEASING.md) before merging more.",
    );
  }
  const released = new Set(published.map((r) => r.tag));
  for (const key of keys) {
    if (key !== version && !released.has(key)) {
      problems.push(`versions.json names ${key}, which has no published release; remove it`);
    }
  }
  return out("release");
}

// ---- I/O below: `gh` against this repository, and the files at the repository root ----

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

/** `gh`'s stdout. A 404 is `null` when `notFound` allows it; any other failure throws. */
function gh(args, { notFound = false } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (notFound && /HTTP 404|Not Found/.test(String(error.stderr))) return null;
    throw error;
  }
}

function listReleases(repo) {
  const raw = gh(["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", ".[]"]);
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .map((r) => ({
      id: r.id,
      tag: r.tag_name,
      draft: r.draft,
      assets: r.assets.map((a) => a.name),
    }));
}

function baseVersion(repo) {
  const sha = process.env.BASE_SHA;
  if (!sha || /^0+$/.test(sha)) return null;
  const raw = gh(
    [
      "api",
      `repos/${repo}/contents/manifest.json?ref=${sha}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
    { notFound: true },
  );
  return raw === null ? null : JSON.parse(raw).version;
}

function facts(repo) {
  const manifest = JSON.parse(read("manifest.json"));
  const tag = gh(["api", `repos/${repo}/git/ref/tags/${manifest.version}`], { notFound: true });
  return {
    manifest,
    versions: JSON.parse(read("versions.json")),
    changelog: read("CHANGELOG.md"),
    releases: listReleases(repo),
    tagExists: tag !== null,
    baseVersion: baseVersion(repo),
  };
}

/** The named published assets whose bytes differ from the files here. */
function differingAssets(repo, version, names) {
  const dir = mkdtempSync(join(tmpdir(), "published-"));
  try {
    gh(["release", "download", version, "-R", repo, "-D", dir, ...names.flatMap((a) => ["-p", a])]);
    return names.filter((a) => !readFileSync(join(dir, a)).equals(readFileSync(join(root, a))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fail(messages) {
  for (const m of messages) console.error(`::error::${m}`);
  process.exit(1);
}

function main(argv) {
  const mode = argv[0];
  const notesAt = argv.includes("--notes") ? argv[argv.indexOf("--notes") + 1] : undefined;
  if (!["check", "plan", "publish"].includes(mode)) {
    throw new Error("usage: release.mjs check | plan --notes <file> | publish <version>");
  }
  if (mode === "plan" && !notesAt) throw new Error("plan needs --notes <file>");
  if (mode === "publish" && !SEMVER.test(argv[1] ?? "")) throw new Error("publish needs x.y.z");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set (owner/name)");

  if (mode === "publish") {
    // The write job. Replaces a draft a run that died partway left behind (`gh release
    // create` deletes its own on an upload or publish failure; a runner that dies does not),
    // and refuses if the version was published meanwhile.
    const version = argv[1];
    for (const r of listReleases(repo).filter((x) => x.tag === version)) {
      if (!r.draft) fail([`release ${version} is already published`]);
      gh(["api", "-X", "DELETE", `repos/${repo}/releases/${r.id}`]);
      console.log(`deleted a leftover draft of ${version}`);
    }
    return;
  }

  const decision = decide(facts(repo));
  if (decision.problems.length > 0) fail(decision.problems);

  if (decision.action === "released") {
    // HEAD's manifest is what Obsidian reads, so it must equal the released one exactly.
    if (differingAssets(repo, decision.version, ["manifest.json"]).length > 0) {
      fail([
        `manifest.json differs from release ${decision.version}'s: Obsidian reads it from ` +
          "HEAD. Bump the version (manifest.json, versions.json, CHANGELOG.md) to change it.",
      ]);
    }
    if (differingAssets(repo, decision.version, ["main.js"]).length > 0) {
      console.log(
        `::notice::main.js differs from release ${decision.version}: unreleased changes, ` +
          "shipped with the next version bump.",
      );
    }
    console.log(`${decision.version} is the latest release; nothing to publish`);
    return;
  }

  if (mode === "check") {
    console.log(`this change releases ${decision.version}`);
    return;
  }
  writeFileSync(notesAt, `${decision.notes}\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `version=${decision.version}\n`, { flag: "a" });
  }
  console.log(`planning release ${decision.version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
