// The comment `main.js` opens with: this plugin's licence, and the licence of every
// package the bundle inlines.
//
// **Why it exists.** A minified esbuild bundle keeps no comments, so `@noble/ed25519`'s
// copyright notice — which its MIT licence requires in "all copies or substantial
// portions" — was absent from `main.js`, the one file a user actually receives. The
// licence texts are read from disk rather than pasted here, so a dependency that changes
// its notice changes the banner with it.
//
// `BUNDLED` is checked against what esbuild ACTUALLY inlined, at build time: the build
// fails if the bundle holds a package this list does not name (`bundledPackages`, fed
// esbuild's metafile). package.json is not the check, because a devDependency imported
// into shipped code is bundled just the same. Everything under `external` in
// `esbuild.config.mjs` is supplied by Obsidian at runtime and never bundled.
import { readFileSync } from "node:fs";

const here = (path) => new URL(`../${path}`, import.meta.url);

export const BUNDLED = ["@noble/ed25519"];

export const banner = () => {
  const own = readFileSync(here("LICENSE"), "utf8").trim();
  const bundled = BUNDLED.map(
    (name) => `${name}\n\n${readFileSync(here(`node_modules/${name}/LICENSE`), "utf8").trim()}`,
  );
  // `*/` inside a licence text would end the comment early and break the bundle.
  const body = [own, ...bundled].join("\n\n---\n\n").replaceAll("*/", "* /");
  return `/*!\nCtrl Notes Cloud MCP, the Obsidian plugin. Its licence, then the licences of what it bundles.\n\n${body}\n*/`;
};

/**
 * The packages a bundle inlined, from esbuild's `metafile.inputs` keys: the name after
 * the LAST `node_modules/` in each path (bun's store nests one inside another), scoped
 * names kept whole.
 */
export const bundledPackages = (inputs) => {
  const names = new Set();
  for (const path of inputs) {
    const at = path.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const [first, second] = path.slice(at + "node_modules/".length).split("/");
    names.add(first.startsWith("@") ? `${first}/${second}` : first);
  }
  return [...names].sort();
};

/** Throws, naming them, if the bundle inlined a package the banner carries no notice for. */
export const assertNoticesCover = (inputs) => {
  const missing = bundledPackages(inputs).filter((name) => !BUNDLED.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `main.js inlines ${missing.join(", ")} with no licence notice: add each to BUNDLED ` +
        "in tools/licence-banner.mjs",
    );
  }
};
