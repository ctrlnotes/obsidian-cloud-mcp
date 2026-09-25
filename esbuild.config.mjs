// Obsidian evaluates `main.js` as CommonJS; ESM output fails to load with no useful error.
// `target: es2018` because `isDesktopOnly` is false and mobile runs older WebViews — a
// newer target fails on mobile ONLY, which is the worst place to find out.
import esbuild from "esbuild";
import { assertNoticesCover, banner } from "./tools/licence-banner.mjs";

// **The default IS the shipping artifact.** `--dev` opts into an inline sourcemap for
// debugging inside a real vault; nothing needs it yet, but the alternative is writing this
// flag under pressure the day something does.
const dev = process.argv.includes("--dev");

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "browser",
  // Supplied by the host at runtime. Inlining any of these breaks the plugin.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  treeShaking: true,
  // Licences, ours and those of what is inlined — minifying drops every other comment.
  banner: { js: banner() },
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  logLevel: "info",
  metafile: true,
});

// A package inlined with no notice in the banner fails the build, not the release.
assertNoticesCover(Object.keys(result.metafile.inputs));
