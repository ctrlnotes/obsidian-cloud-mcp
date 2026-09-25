import { describe, expect, it } from "vitest";
import { changelogSection, compareVersions, decide } from "./release.mjs";

const CHANGELOG = "# Changelog\n\n## 0.0.2\n\nFixed a thing.\n\n## 0.0.1\n\nFirst release.\n";

/** Facts for a repository that has released 0.0.1 and is about to release 0.0.2. */
const facts = (over = {}) => ({
  manifest: { version: "0.0.2", minAppVersion: "1.13.4" },
  versions: { "0.0.1": "1.13.4", "0.0.2": "1.13.4" },
  changelog: CHANGELOG,
  releases: [{ id: 1, tag: "0.0.1", draft: false, assets: ["main.js", "manifest.json"] }],
  tagExists: false,
  baseVersion: "0.0.1",
  desktopLatest: "1.13.7",
  ...over,
});

describe("compareVersions", () => {
  it("compares numerically, not as strings", () => {
    expect(compareVersions("0.0.10", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("refuses anything that is not x.y.z", () => {
    expect(() => compareVersions("v1.0.0", "1.0.0")).toThrow(/v1\.0\.0/);
  });
});

describe("changelogSection", () => {
  it("returns one version's body and stops at the next heading", () => {
    expect(changelogSection(CHANGELOG, "0.0.2")).toBe("Fixed a thing.");
    expect(changelogSection(CHANGELOG, "0.0.1")).toBe("First release.");
  });

  it("accepts CRLF line endings", () => {
    expect(changelogSection(CHANGELOG.replaceAll("\n", "\r\n"), "0.0.2")).toBe("Fixed a thing.");
  });

  it("does not take a heading inside a code fence for a section", () => {
    const text = "## 0.0.2\n\nSee:\n\n```md\n## 0.0.1\n```\n\n## 0.0.1\n\nFirst.\n";
    expect(changelogSection(text, "0.0.2")).toBe("See:\n\n```md\n## 0.0.1\n```");
  });

  it("is null for a missing or empty section", () => {
    expect(changelogSection(CHANGELOG, "0.0.3")).toBeNull();
    expect(changelogSection("## 0.0.3\n\n## 0.0.2\n\nx\n", "0.0.3")).toBeNull();
  });
});

describe("decide", () => {
  it("releases a new version whose files agree", () => {
    const d = decide(facts());
    expect(d.problems).toEqual([]);
    expect(d).toMatchObject({ action: "release", version: "0.0.2", notes: "Fixed a thing." });
  });

  // The bootstrap: the version was set before any release job existed, so the base already
  // carries it, and there is no earlier run to re-run.
  it("releases the first version when nothing is released yet, even from a base that had it", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.4" },
        versions: { "0.0.1": "1.13.4" },
        releases: [],
        baseVersion: "0.0.1",
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d.action).toBe("release");
  });

  it("recognises the latest release instead of releasing it again", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.4" },
        versions: { "0.0.1": "1.13.4" },
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d.action).toBe("released");
  });

  // Each refusal, one at a time, so a check that stopped firing is named by its own case.
  it.each([
    ["a v prefix", { manifest: { version: "v0.0.2", minAppVersion: "1.13.4" } }, /not x\.y\.z/],
    [
      "versions.json not mapping the version",
      { versions: { "0.0.1": "1.13.4" } },
      /must map "0\.0\.2"/,
    ],
    [
      "versions.json mapping it to another minAppVersion",
      { versions: { "0.0.1": "1.13.4", "0.0.2": "1.12.0" } },
      /minAppVersion "1\.13\.4"/,
    ],
    [
      "a higher key in versions.json than the manifest",
      { versions: { "0.0.1": "1.13.4", "0.0.2": "1.13.4", "0.0.3": "1.13.4" } },
      /highest version is 0\.0\.3/,
    ],
    ["no changelog section", { changelog: "## 0.0.1\n\nFirst.\n" }, /no non-empty "## 0\.0\.2"/],
    [
      "a version below the highest release",
      {
        releases: [{ id: 3, tag: "0.0.3", draft: false, assets: ["main.js", "manifest.json"] }],
        versions: { "0.0.2": "1.13.4" },
      },
      /must be above the highest release, 0\.0\.3/,
    ],
    ["a tag with no release", { tagExists: true }, /tag 0\.0\.2 exists with no release/],
    // 0.0.1 shipped with minAppVersion 1.13.8, an Android-only release: no desktop could
    // install it. The desktop feed said 1.13.7.
    [
      "a minAppVersion newer than the current desktop release",
      {
        manifest: { version: "0.0.2", minAppVersion: "1.13.8" },
        versions: { "0.0.1": "1.13.4", "0.0.2": "1.13.8" },
      },
      /minAppVersion 1\.13\.8 is newer than Obsidian's current desktop release, 1\.13\.7/,
    ],
    [
      "a versions.json key that is not x.y.z",
      { versions: { "0.0.1": "1.13.4", "0.0.1-beta": "1.13.4", "0.0.2": "1.13.4" } },
      /key "0\.0\.1-beta" is not x\.y\.z/,
    ],
    [
      "a version in versions.json that was never released (skipped, or never shipped)",
      {
        manifest: { version: "0.0.3", minAppVersion: "1.13.4" },
        versions: { "0.0.1": "1.13.4", "0.0.2": "1.13.4", "0.0.3": "1.13.4" },
        changelog: "## 0.0.3\n\nThird.\n",
      },
      /names 0\.0\.2, which has no published release/,
    ],
  ])("refuses %s", (_name, over, message) => {
    const d = decide(facts(over));
    expect(d.action).toBe("none");
    expect(d.problems.join("\n")).toMatch(message);
  });

  it("refuses a published release that is missing an asset", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.4" },
        versions: { "0.0.1": "1.13.4" },
        releases: [{ id: 1, tag: "0.0.1", draft: false, assets: ["main.js"] }],
      }),
    );
    expect(d.action).toBe("none");
    expect(d.problems.join("\n")).toMatch(/published without manifest\.json/);
  });

  // A release job that failed or was cancelled after a bump merged leaves the version set
  // and unreleased. The next change must not publish its own code under that version.
  it("refuses to finish a pending release from a later change", () => {
    const d = decide(facts({ baseVersion: "0.0.2" }));
    expect(d.action).toBe("none");
    expect(d.problems.join("\n")).toMatch(/release 0\.0\.2 is pending/);
  });

  it("refuses a manifest that names an older release than the latest (a reverted bump)", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.4" },
        versions: { "0.0.1": "1.13.4" },
        releases: [
          { id: 1, tag: "0.0.1", draft: false, assets: ["main.js", "manifest.json"] },
          { id: 2, tag: "0.0.2", draft: false, assets: ["main.js", "manifest.json"] },
        ],
      }),
    );
    expect(d.action).toBe("none");
    expect(d.problems.join("\n")).toMatch(/advertise an older version/);
  });

  // A draft is never public, and the read-only token `check` and `plan` use cannot see one.
  it("ignores drafts", () => {
    const d = decide(
      facts({
        releases: [
          { id: 1, tag: "0.0.1", draft: false, assets: ["main.js", "manifest.json"] },
          { id: 9, tag: "0.0.2", draft: true, assets: ["main.js"] },
        ],
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d.action).toBe("release");
  });
});
