import { describe, expect, it } from "vitest";
import { changelogSection, compareVersions, decide } from "./release.mjs";

const CHANGELOG = "# Changelog\n\n## 0.0.2\n\nFixed a thing.\n\n## 0.0.1\n\nFirst release.\n";

/** Facts for a repository that has released 0.0.1 and is about to release 0.0.2. */
const facts = (over = {}) => ({
  manifest: { version: "0.0.2", minAppVersion: "1.13.8" },
  versions: { "0.0.1": "1.13.8", "0.0.2": "1.13.8" },
  changelog: CHANGELOG,
  releases: [{ id: 1, tag: "0.0.1", draft: false, assets: ["main.js", "manifest.json"] }],
  tagExists: false,
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

  it("releases the first version when nothing is released yet", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.8" },
        versions: { "0.0.1": "1.13.8" },
        releases: [],
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d.action).toBe("release");
  });

  it("compares against an existing release instead of releasing it again", () => {
    const d = decide(
      facts({
        manifest: { version: "0.0.1", minAppVersion: "1.13.8" },
        versions: { "0.0.1": "1.13.8" },
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d.action).toBe("compare");
  });

  // Each refusal, one at a time, so a check that stopped firing is named by its own case.
  it.each([
    ["a v prefix", { manifest: { version: "v0.0.2", minAppVersion: "1.13.8" } }, /not x\.y\.z/],
    [
      "versions.json not mapping the version",
      { versions: { "0.0.1": "1.13.8" } },
      /must map "0\.0\.2"/,
    ],
    [
      "versions.json mapping it to another minAppVersion",
      { versions: { "0.0.1": "1.13.8", "0.0.2": "1.12.0" } },
      /minAppVersion "1\.13\.8"/,
    ],
    [
      "a higher key in versions.json than the manifest",
      { versions: { "0.0.1": "1.13.8", "0.0.2": "1.13.8", "0.0.3": "1.13.8" } },
      /highest version is 0\.0\.3/,
    ],
    ["no changelog section", { changelog: "## 0.0.1\n\nFirst.\n" }, /no non-empty "## 0\.0\.2"/],
    [
      "a version below the highest release",
      {
        releases: [{ id: 3, tag: "0.0.3", draft: false, assets: ["main.js", "manifest.json"] }],
        versions: { "0.0.2": "1.13.8" },
      },
      /must be above the highest release, 0\.0\.3/,
    ],
    ["a tag with no release", { tagExists: true }, /tag 0\.0\.2 exists with no release/],
    [
      "a versions.json key that is not x.y.z",
      { versions: { "0.0.1": "1.13.8", "0.0.1-beta": "1.13.8", "0.0.2": "1.13.8" } },
      /key "0\.0\.1-beta" is not x\.y\.z/,
    ],
    [
      "a version in versions.json that was never released (skipped, or never shipped)",
      {
        manifest: { version: "0.0.3", minAppVersion: "1.13.8" },
        versions: { "0.0.1": "1.13.8", "0.0.2": "1.13.8", "0.0.3": "1.13.8" },
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
        manifest: { version: "0.0.1", minAppVersion: "1.13.8" },
        versions: { "0.0.1": "1.13.8" },
        releases: [{ id: 1, tag: "0.0.1", draft: false, assets: ["main.js"] }],
      }),
    );
    expect(d.action).toBe("none");
    expect(d.problems.join("\n")).toMatch(/published without manifest\.json/);
  });

  // `gh release create` makes a draft, uploads, then publishes: a run that died between
  // those leaves a draft and a tag. Nothing of it was public, so it is replaced, not trusted
  // and not treated as a release that already happened.
  it("replaces a draft a failed run left behind", () => {
    const d = decide(
      facts({
        tagExists: true,
        releases: [
          { id: 1, tag: "0.0.1", draft: false, assets: ["main.js", "manifest.json"] },
          { id: 9, tag: "0.0.2", draft: true, assets: ["main.js"] },
        ],
      }),
    );
    expect(d.problems).toEqual([]);
    expect(d).toMatchObject({ action: "release", deleteDraft: 9 });
  });
});
