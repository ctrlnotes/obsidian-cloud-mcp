// @wire-source server/src/sync/code-path.ts
// @wire-end
/**
 * Code and script extensions, refused **anywhere in the vault** (PLUGIN §4a rule 3).
 *
 * **The single definition**, as `TEXT_EXTENSIONS` is for prose — §4a's own instruction is
 * to import the list rather than restate it. The plugin carries a stamped copy, held
 * byte-identical by the gate's `VENDORED` table rather than by a test — which is why this
 * file imports nothing: a vendored copy must stand alone in a tree that has no `server/`.
 * The predicate lives in `vault-path.ts`, beside `extension`, for that same reason.
 *
 * The reason is not tidiness: a vault syncs to a desktop app with a plugin runtime, so
 * code that lands anywhere is code that can later be moved somewhere that runs it.
 *
 * A deny-list is the right shape **here specifically** because it narrows an
 * already-permitted set. Attachments are the residual category, so a format nobody
 * thought to list still syncs as opaque bytes; the cost of an omission is "a .foo file
 * synced", not "a .exe executed".
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "com",
  "exe",
  "dll",
  "so",
  "dylib",
  "wasm",
  "jar",
  "scpt",
  "applescript",
  "vbs",
  "php",
  "pl",
  "lua",
]);
