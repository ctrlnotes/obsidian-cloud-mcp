// Obsidian's own review rules, run on every `moonx plugin:lint`.
//
// **Why this exists beside Biome.** Biome formats and lints the TypeScript as
// TypeScript. The community directory's automatic review runs
// `eslint-plugin-obsidianmd`'s `recommended` config, which knows things Biome
// cannot: the Obsidian API a `minAppVersion` actually has, popout-window timer
// and DOM rules, sentence case in UI text, `vault.configDir` over a hardcoded
// `.obsidian`, the deprecated settings `display()`, and the manifest's own
// shape. Running it here means the directory finds nothing CI has not already.
//
// The version is pinned exactly in package.json: a new rule in the reviewer's
// set should arrive as a pull request here, not as a surprise at submission.
//
// Scope is the SHIPPED code. Tests and their doubles are Node programs that
// import `node:fs` on purpose, and the build and install scripts never reach a
// user; none of them is in `main.js`.
//
// The rules read `manifest.json` from the working directory (to know
// `isDesktopOnly` and `minAppVersion`), so this must run from `apps/plugin` —
// which is where moon runs the task.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "tools/**",
      "src/testing/**",
      "**/*.test.ts",
      "*.config.mjs",
      "*.config.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // **The manifest, linted by the directory's own rule.** `validate-manifest` is in the
  // recommended set but only runs on a file eslint is given and can parse, and until
  // 2026-09-24 `lint` passed only `src` and `package.json` — so a description containing
  // "Obsidian", which the rule rejects, was green here. The TS parser reads JSON as an
  // expression, which is the AST the rule walks.
  {
    files: ["manifest.json"],
    languageOptions: { parser: tseslint.parser },
    plugins: { obsidianmd },
    rules: { "obsidianmd/validate-manifest": "error" },
  },
);
