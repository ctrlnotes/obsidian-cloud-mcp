// Installs the built plugin into a local Obsidian vault, and removes it again. The point
// is the round trip: a vault you can install into, restart, and clear out, without hand
// copying the bundle in each time.
//
// Obsidian loads a plugin from `<vault>/.obsidian/plugins/<manifest id>/`, and it reads
// that directory at startup only — after an install or an uninstall, reload the vault
// (Ctrl+P, "Reload app without saving") before the change is visible.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The files Obsidian reads. `styles.css` is optional and the plugin ships none, so it is
// absent here rather than copied conditionally — add it when it exists. `data.json` is not
// here because Obsidian writes it, not the build; it is carried across a reinstall below.
const FILES = ["main.js", "manifest.json"];

/**
 * @param {readonly string[]} argv arguments after the script name
 * @returns {{vault: string, mode: "copy" | "link", uninstall: boolean}}
 */
export function parseArgs(argv) {
  let vault;
  let mode = "copy";
  let uninstall = false;
  for (const arg of argv) {
    if (arg === "--link") mode = "link";
    else if (arg === "--uninstall") uninstall = true;
    else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
    else if (vault !== undefined) throw new Error("expected one vault path, got two");
    else vault = arg;
  }
  if (vault === undefined) throw new Error("expected a vault path");
  return { vault, mode, uninstall };
}

/**
 * @param {string} vault path to the vault root
 * @param {string} id the manifest id
 * @returns {string}
 */
export function pluginDir(vault, id) {
  return join(resolve(vault), ".obsidian", "plugins", id);
}

/**
 * The imperative shell: everything that touches the filesystem, and nothing that decides.
 * `root` and `log` are parameters rather than module state so the test harness can point
 * the whole thing at a temporary directory.
 *
 * @param {object} options
 * @param {string} options.vault vault root to install into
 * @param {"copy" | "link"} [options.mode] ignored when uninstalling
 * @param {boolean} [options.uninstall]
 * @param {string} options.root the built plugin source directory
 * @param {(message: string) => void} [options.log]
 */
export async function install({
  vault,
  mode = "copy",
  uninstall = false,
  root,
  log = console.log,
}) {
  const vaultRoot = resolve(vault);

  // A vault is a directory that holds `.obsidian`. Refuse anything else: an install into a
  // mistyped path creates the directory tree and then looks like it worked.
  if (!existsSync(join(vaultRoot, ".obsidian"))) {
    // Name the resolved path AND the given one when they differ. A task runner may set the
    // cwd to this repository rather than the shell's, so a relative path resolves somewhere
    // the user never typed and a message naming only one of the two reads as a lie.
    const given = vaultRoot === vault ? "" : ` (from ${vault})`;
    throw new Error(`${vaultRoot}${given} is not an Obsidian vault (no .obsidian directory)`);
  }

  const { id } = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const target = pluginDir(vaultRoot, id);

  if (uninstall) {
    // `rm` follows no symlink, so a linked install removes the link and leaves the repo.
    await rm(target, { recursive: true, force: true });
    log(`removed ${target}`);
    return;
  }

  if (!existsSync(join(root, "main.js"))) {
    throw new Error("main.js is missing — run `bun run build` first");
  }

  // Replace rather than merge: a stale file from an earlier layout must not survive.
  // `data.json` is the exception, and it is not a nicety — Obsidian keeps plugin settings
  // there, `serverUrl` among them, and every sync path returns early when that is empty.
  // Dropping it on a reinstall leaves a plugin that still looks paired, because the link
  // credential lives in `secretStorage` outside the vault, and syncs nothing at all.
  const settings = await readFile(join(target, "data.json")).catch(() => undefined);
  await rm(target, { recursive: true, force: true });

  if (mode === "link") {
    await mkdir(dirname(target), { recursive: true });
    await symlink(root, target, "dir");
    // The link makes the source tree the plugin directory, so that is where the settings
    // have to land. `plugin/data.json` is git-ignored for exactly this reason.
    if (settings) await writeFile(join(root, "data.json"), settings);
    log(`linked ${target} -> ${root}`);
    log("rebuild with `bun run build`, then reload the vault");
    return;
  }

  await mkdir(target, { recursive: true });
  for (const file of FILES) await copyFile(join(root, file), join(target, file));
  if (settings) await writeFile(join(target, "data.json"), settings);
  log(`installed ${FILES.join(", ")} to ${target}`);
  log("reload the vault, then enable Ctrl Notes Cloud MCP under Settings > Community plugins");
}

// Run only as a script. The test imports the functions above and must install nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // `parseArgs` throws synchronously, so the try must hold it too — a `.catch` on the
  // promise alone prints a stack trace for the commonest mistake, a mistyped flag.
  try {
    await install({ ...parseArgs(process.argv.slice(2)), root });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
