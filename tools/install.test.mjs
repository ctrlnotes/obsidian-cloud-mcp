import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, parseArgs, pluginDir } from "./install.mjs";

describe("parseArgs", () => {
  it("reads the vault path from the first positional argument", () => {
    expect(parseArgs(["/vaults/notes"])).toEqual({
      vault: "/vaults/notes",
      mode: "copy",
      uninstall: false,
    });
  });

  it("selects the symlink mode with --link", () => {
    expect(parseArgs(["--link", "/vaults/notes"]).mode).toBe("link");
  });

  it("selects uninstall with --uninstall, which needs no mode", () => {
    expect(parseArgs(["/vaults/notes", "--uninstall"]).uninstall).toBe(true);
  });

  it("refuses a call with no vault path", () => {
    expect(() => parseArgs([])).toThrow(/vault path/i);
  });

  it("refuses a flag it does not know, because a typo must not install to a wrong mode", () => {
    expect(() => parseArgs(["--symlink", "/vaults/notes"])).toThrow(/--symlink/);
  });

  it("refuses a second positional argument", () => {
    expect(() => parseArgs(["/a", "/b"])).toThrow(/one vault path/i);
  });
});

describe("pluginDir", () => {
  it("puts the plugin under .obsidian/plugins, keyed by the manifest id", () => {
    expect(pluginDir("/vaults/notes", "ctrl-notes-cloud-mcp")).toBe(
      "/vaults/notes/.obsidian/plugins/ctrl-notes-cloud-mcp",
    );
  });

  it("normalises a trailing separator", () => {
    expect(pluginDir("/vaults/notes/", "ctrl-notes-cloud-mcp")).toBe(
      "/vaults/notes/.obsidian/plugins/ctrl-notes-cloud-mcp",
    );
  });
});

// The harness works on real directories under the system temp root, because every claim
// below is a filesystem claim — a symlink that a mock reports as created tells you
// nothing about whether `rm` follows it.
describe("install, against real directories", () => {
  /** @type {string} */ let scratch;
  /** @type {string} */ let vault;
  /** @type {string} */ let notAVault;
  /** @type {string} */ let source;
  /** @type {string} */ let target;

  // A source tree standing in for the built plugin. It is a fixture rather than the real
  // `plugin/` directory so the harness holds whether or not `main.js` was built, and so a
  // test can assert on file CONTENT it chose.
  const build = async (mainJs = "module.exports = 1;\n") => {
    await writeFile(join(source, "main.js"), mainJs);
    await writeFile(join(source, "manifest.json"), JSON.stringify({ id: "ctrl-notes-cloud-mcp" }));
  };

  const run = (options) => install({ root: source, log: () => {}, ...options });

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "ctrlrouter-install-"));
    vault = join(scratch, "vault");
    notAVault = join(scratch, "plain-directory");
    source = join(scratch, "source");
    target = join(vault, ".obsidian", "plugins", "ctrl-notes-cloud-mcp");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await mkdir(notAVault, { recursive: true });
    await mkdir(source, { recursive: true });
    await build();
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("copies the two files Obsidian reads into the vault", async () => {
    await run({ vault, mode: "copy", uninstall: false });

    expect((await readdir(target)).sort()).toEqual(["main.js", "manifest.json"]);
    expect(await readFile(join(target, "main.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("copies, so a later rebuild does NOT reach the vault until the next install", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await build("module.exports = 2;\n");

    expect(await readFile(join(target, "main.js"), "utf8")).toBe("module.exports = 1;\n");

    await run({ vault, mode: "copy", uninstall: false });
    expect(await readFile(join(target, "main.js"), "utf8")).toBe("module.exports = 2;\n");
  });

  it("links, so a rebuild reaches the vault with no second install", async () => {
    await run({ vault, mode: "link", uninstall: false });

    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    await build("module.exports = 2;\n");
    expect(await readFile(join(target, "main.js"), "utf8")).toBe("module.exports = 2;\n");
  });

  it("replaces a copy with a link, and a link with a copy", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await run({ vault, mode: "link", uninstall: false });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    await run({ vault, mode: "copy", uninstall: false });
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect((await readdir(target)).sort()).toEqual(["main.js", "manifest.json"]);
  });

  // `data.json` is Obsidian's home for plugin settings — `serverUrl` lives there
  // (`src/main.ts`), and every sync path returns early when it is empty. A reinstall that
  // dropped it would leave a plugin that still LOOKS paired, because the link credential
  // lives in `secretStorage` outside the vault, and silently syncs nothing.
  it("keeps the settings Obsidian wrote, across a reinstall", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await writeFile(join(target, "data.json"), '{"serverUrl":"http://localhost:8787"}');

    await run({ vault, mode: "copy", uninstall: false });

    expect(await readFile(join(target, "data.json"), "utf8")).toBe(
      '{"serverUrl":"http://localhost:8787"}',
    );
  });

  it("keeps the settings when a copy becomes a link, and hands them to the link", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await writeFile(join(target, "data.json"), '{"serverUrl":"http://localhost:8787"}');

    await run({ vault, mode: "link", uninstall: false });

    expect(await readFile(join(source, "data.json"), "utf8")).toBe(
      '{"serverUrl":"http://localhost:8787"}',
    );
  });

  // An uninstall is the user asking for the plugin to be gone. Settings go with it.
  it("removes the settings on uninstall", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await writeFile(join(target, "data.json"), "{}");

    await run({ vault, uninstall: true });

    expect(await readdir(join(vault, ".obsidian", "plugins"))).toEqual([]);
  });

  it("leaves no other file from an earlier install behind", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await writeFile(join(target, "styles.css"), "/* from an older layout */");

    await run({ vault, mode: "copy", uninstall: false });

    expect(await readdir(target)).not.toContain("styles.css");
  });

  it("uninstalls a copy", async () => {
    await run({ vault, mode: "copy", uninstall: false });
    await run({ vault, uninstall: true });

    expect(await readdir(join(vault, ".obsidian", "plugins"))).toEqual([]);
  });

  // regression-shaped: `rm -r` through a symlink would delete the developer's source
  // tree. This asserts the source survives, not only that the link is gone.
  it("uninstalls a link by removing the link, and keeps the source tree", async () => {
    await run({ vault, mode: "link", uninstall: false });
    await run({ vault, uninstall: true });

    expect(await readdir(join(vault, ".obsidian", "plugins"))).toEqual([]);
    expect((await readdir(source)).sort()).toEqual(["main.js", "manifest.json"]);
  });

  it("uninstalls when nothing is installed, without failing", async () => {
    await expect(run({ vault, uninstall: true })).resolves.toBeUndefined();
  });

  it("refuses a directory that is not a vault, and writes nothing to it", async () => {
    await expect(run({ vault: notAVault, mode: "copy", uninstall: false })).rejects.toThrow(
      /not an Obsidian vault/,
    );

    expect(await readdir(notAVault)).toEqual([]);
  });

  it("refuses to uninstall from a directory that is not a vault", async () => {
    await expect(run({ vault: notAVault, uninstall: true })).rejects.toThrow(
      /not an Obsidian vault/,
    );
  });

  it("refuses to install an unbuilt source tree", async () => {
    await rm(join(source, "main.js"));

    await expect(run({ vault, mode: "copy", uninstall: false })).rejects.toThrow(/main\.js/);
  });
});
