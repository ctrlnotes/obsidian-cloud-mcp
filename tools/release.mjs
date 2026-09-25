// Decides whether a push releases, and refuses the mistakes that would ship something wrong.
//
//   node tools/release.mjs check                     # every push and pull request (read-only)
//   node tools/release.mjs release --notes <file>    # the release job, on a push to main
//
// **A release is a pull request that bumps `manifest.json`'s `version`** (RELEASING.md). The
// merge's push reaches the release job, which tags that commit and publishes `main.js` and
// `manifest.json`. Obsidian reads the manifest at the default branch's HEAD and downloads the
// release whose tag equals its version, so the checks that can run before a merge run in `check`
// on the pull request — a mistake is caught while it is still a diff, not after it is public.
//
// What `decide` refuses, and why each matters:
// - a version that is not `x.y.z` (Obsidian's tags carry no `v`);
// - `versions.json` disagreeing with the manifest (an older Obsidian picks its release from it);
// - no `## x.y.z` section in `CHANGELOG.md` (it becomes the release notes);
// - a version at or below one already published;
// - a `versions.json` key with no published release (an older Obsidian would get a 404);
// - a tag with no release, or a published release missing an asset — half-done states that
//   need a person, not a retry.
// And the CLI refuses shipped files that changed while the version did not: the bundle built
// here must equal the published one, or the pull request has to bump the version.
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

/** The body of `## <version>` in a changelog, trimmed, or null when there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * The decision, from facts alone.
 *
 * @param {{
 *   manifest: {version: string, minAppVersion: string},
 *   versions: Record<string, string>,
 *   changelog: string,
 *   releases: {id: number, tag: string, draft: boolean, assets: string[]}[],
 *   tagExists: boolean,
 * }} facts
 * @returns {{problems: string[], action: "release" | "compare" | "none",
 *   version: string, notes: string | null, deleteDraft: number | null}}
 */
export function decide({ manifest, versions, changelog, releases, tagExists }) {
  const problems = [];
  const { version, minAppVersion } = manifest;
  let notes = null;
  const out = (action, extra = {}) => ({
    problems,
    action: problems.length > 0 ? "none" : action,
    version,
    notes,
    deleteDraft: null,
    ...extra,
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

  const published = releases.filter((r) => !r.draft);
  const existing = published.find((r) => r.tag === version);
  if (existing) {
    const missing = ASSETS.filter((a) => !existing.assets.includes(a));
    if (missing.length > 0) {
      problems.push(
        `release ${version} is published without ${missing.join(", ")}; needs a person`,
      );
    }
    return out("compare");
  }

  const draft = releases.find((r) => r.draft && r.tag === version);
  if (tagExists && !draft) {
    problems.push(`tag ${version} exists with no release; needs a person, not a retry`);
  }
  const highestPublished = published
    .map((r) => r.tag)
    .filter((t) => SEMVER.test(t))
    .sort(compareVersions)
    .at(-1);
  if (highestPublished !== undefined && compareVersions(version, highestPublished) <= 0) {
    problems.push(`version ${version} must be above the highest release, ${highestPublished}`);
  }
  const released = new Set(published.map((r) => r.tag));
  for (const key of keys) {
    if (key !== version && !released.has(key)) {
      problems.push(`versions.json names ${key}, which has no published release; remove it`);
    }
  }
  return out("release", { deleteDraft: draft ? draft.id : null });
}

// ---- I/O below: `gh` against this repository, and the files at the repository root ----

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function facts(repo) {
  const manifest = JSON.parse(read("manifest.json"));
  const raw = gh(["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", ".[]"]);
  const releases = raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .map((r) => ({
      id: r.id,
      tag: r.tag_name,
      draft: r.draft,
      assets: r.assets.map((a) => a.name),
    }));
  const tagExists =
    gh(["api", `repos/${repo}/git/ref/tags/${manifest.version}`], { allowFailure: true }) !== null;
  return {
    manifest,
    versions: JSON.parse(read("versions.json")),
    changelog: read("CHANGELOG.md"),
    releases,
    tagExists,
  };
}

/** The assets whose published bytes differ from the ones built here (empty when identical). */
function differingAssets(repo, version) {
  const dir = mkdtempSync(join(tmpdir(), "published-"));
  try {
    gh([
      "release",
      "download",
      version,
      "-R",
      repo,
      "-D",
      dir,
      ...ASSETS.flatMap((a) => ["-p", a]),
    ]);
    return ASSETS.filter((a) => !readFileSync(join(dir, a)).equals(readFileSync(join(root, a))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const mode = argv[0];
  if (mode !== "check" && mode !== "release") {
    throw new Error("usage: release.mjs check | release --notes <file>");
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set (owner/name)");

  const decision = decide(facts(repo));
  if (decision.problems.length > 0) {
    for (const p of decision.problems) console.error(`::error::${p}`);
    process.exit(1);
  }

  if (decision.action === "compare") {
    const differ = differingAssets(repo, decision.version);
    if (differ.length > 0) {
      console.error(
        `::error::${differ.join(" and ")} differ from release ${decision.version}: shipped ` +
          "files changed without a version bump. Bump manifest.json's version, versions.json " +
          "and CHANGELOG.md in this pull request.",
      );
      process.exit(1);
    }
    console.log(`${decision.version} is already released and this build matches it`);
    return;
  }

  if (mode === "check") {
    console.log(`merging this releases ${decision.version}`);
    return;
  }

  // mode === "release", action === "release"
  if (decision.deleteDraft !== null) {
    // A previous run died between creating the draft and publishing it. Nothing of it was
    // ever public, so it is replaced rather than trusted.
    gh(["api", "-X", "DELETE", `repos/${repo}/releases/${decision.deleteDraft}`]);
  }
  const notesAt = argv[argv.indexOf("--notes") + 1];
  if (!argv.includes("--notes") || !notesAt) throw new Error("release needs --notes <file>");
  writeFileSync(notesAt, `${decision.notes}\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `version=${decision.version}\n`, { flag: "a" });
  }
  console.log(`releasing ${decision.version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
