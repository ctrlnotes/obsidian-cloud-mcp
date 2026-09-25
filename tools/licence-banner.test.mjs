import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNoticesCover, BUNDLED, banner, bundledPackages } from "./licence-banner.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("the licence banner main.js opens with", () => {
  it("names every runtime dependency, because each one is inlined into main.js", () => {
    expect([...BUNDLED].sort()).toEqual(Object.keys(pkg.dependencies ?? {}).sort());
  });

  it("carries this plugin's MIT licence", () => {
    expect(banner()).toMatch(/MIT License\s+Copyright \(c\) 2026 The Ctrl Notes authors/);
  });

  it("carries @noble/ed25519's copyright notice and permission text", () => {
    expect(banner()).toContain("Copyright (c) 2019 Paul Miller");
    // Once per licence: ours and noble's.
    expect(banner().match(/Permission is hereby granted/g)).toHaveLength(2);
  });

  it("is one legal comment esbuild keeps when minifying", () => {
    const text = banner();
    expect(text.startsWith("/*!")).toBe(true);
    expect(text.indexOf("*/")).toBe(text.length - 2);
  });
});

describe("what the build checks against the bundle", () => {
  const inputs = [
    "src/main.ts",
    "node_modules/.bun/@noble+ed25519@3.1.0/node_modules/@noble/ed25519/index.js",
    "node_modules/left-pad/index.js",
  ];

  it("names each inlined package once, scoped names kept whole", () => {
    expect(bundledPackages(inputs)).toEqual(["@noble/ed25519", "left-pad"]);
  });

  it("fails the build for a package the banner has no notice for", () => {
    expect(() => assertNoticesCover(inputs)).toThrow(/left-pad/);
    expect(() => assertNoticesCover(inputs.slice(0, 2))).not.toThrow();
  });
});
