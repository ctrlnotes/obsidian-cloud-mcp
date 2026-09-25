// Obsidian's review rules over the TESTS and their doubles, at error level.
//
// `eslint.config.mjs` lints the shipped code at zero warnings. The community directory's
// scan reads every `.ts` file in the repository, tests included, so they are linted too —
// here, where warnings are allowed: tests import `node:fs` and name `.obsidian` on purpose
// (`no-nodejs-modules`, `hardcoded-config-path`), and neither reaches `main.js`. Errors are
// not allowed: they are real defects in a test, such as an unawaited promise.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "tools/**", "test-fixtures/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
