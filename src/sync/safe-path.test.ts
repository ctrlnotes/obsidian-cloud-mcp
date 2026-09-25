import { describe, expect, it } from "vitest";
import { fixture } from "../testing/wire-fixture.ts";
import { classifyPath, decodesAsText, isSafeInboundPath } from "./safe-path.ts";

describe("isSafeInboundPath", () => {
  it.each([
    "a.md",
    "Notes/a.md",
    "Notes/sub/deep/a.md",
    "with space.md",
    "unicode-日本語.md",
    "a.canvas",
    "a.txt",
    "not.obsidian.md",
    "obsidian/a.md",
  ])("accepts %s", (path) => {
    expect(isSafeInboundPath(path)).toBe(true);
  });

  it.each([
    ["escapes the vault", "../outside.md"],
    ["escapes deeper in", "Notes/../../outside.md"],
    ["is absolute", "/etc/passwd"],
    ["is a windows path", "C:\\evil.md"],
    ["uses backslashes", "Notes\\a.md"],
    ["is the config dir", ".obsidian/app.json"],
    ["is our own code", ".obsidian/plugins/ctrl-notes-cloud-mcp/main.js"],
    ["is the config dir exactly", ".obsidian"],
    ["is empty", ""],
    ["is a bare dot", "."],
    ["is a bare dotdot", ".."],
    ["has an empty component", "Notes//a.md"],
    ["has a trailing slash", "Notes/"],
    ["contains a control character", "a\u0000.md"],
    ["contains a newline", "a\n.md"],
    ["is executable", "note.js"],
    ["is executable in a subfolder", "Notes/hook.sh"],
    ["is an executable with odd case", "Notes/HOOK.SH"],
  ])("refuses a path that %s", (_why, path) => {
    expect(isSafeInboundPath(path)).toBe(false);
  });

  it.each(["data.csv", "notes/x.json"])("refuses %s, a format Obsidian does not write", (path) => {
    // These sat beside `base` on the allow-list and were removed with it, justified by
    // "the server enforces no extension rule at all" having been falsified. That was
    // An earlier prototype's server (a `TEXT_EXTENSIONS` constant, a `binary_as_content` refusal); THIS
    // vault has no extension rule at all, so the justification does not carry here — see
    // `ALLOWED_EXTENSIONS`' own comment for the whole retraction. They stay off the list on
    // the remaining, narrower reason: this is an allow-list of the formats Obsidian itself
    // reads and writes, and a `.csv` or `.json` in a vault is somebody else's file.
    expect(isSafeInboundPath(path)).toBe(false);
  });

  /**
   * `base` is Obsidian's own file format, and the whole `apps/vault/src/bases` read
   * surface is dead code without it — `base_views` had no way to gain a row, because no
   * `.base` file could reach the vault.
   *
   * **Proven able to fail**: dropping `"base"` back out of `ALLOWED_EXTENSIONS` turns
   * both spellings red here, and takes `decodesAsText` no notice — which is the point of
   * the pair. This case says the plugin will carry the format; `decodesAsText`'s own
   * cases say it will not carry bytes that are not text whatever the name says.
   */
  it.each(["Notes Base.base", "People/People.base"])(
    "accepts %s, the corpus's own two files",
    (path) => {
      expect(isSafeInboundPath(path)).toBe(true);
      expect(classifyPath(path)).toBe("text");
    },
  );

  it("refuses every extension the server's deny-list names", () => {
    // regression: the list is duplicated from PLUGIN §4a on purpose — this is a floor
    // the plugin holds regardless of what the server enforces, so it must not be
    // "simplified" into trusting the server to have checked.
    for (const ext of "js mjs cjs ts tsx jsx py rb sh bash zsh fish ps1 psm1 bat cmd com exe dll so dylib wasm jar scpt applescript vbs php pl lua".split(
      " ",
    )) {
      expect(isSafeInboundPath(`note.${ext}`), ext).toBe(false);
    }
  });
  it("refuses the config directory in a spelling a case-insensitive filesystem resolves to it", () => {
    // regression: the guard compared `parts[0] === ".obsidian"` exactly, so on APFS and
    // NTFS `.Obsidian/plugins/ctrl-notes-cloud-mcp/manifest.json` reached the config directory — and
    // manifest.json's `main` field names the code Obsidian loads.
    for (const spelling of [".Obsidian", ".OBSIDIAN", ".obsidiaN"]) {
      expect(
        isSafeInboundPath(`${spelling}/plugins/ctrl-notes-cloud-mcp/data.json`),
        spelling,
      ).toBe(false);
    }
  });

  it("refuses a component with a trailing dot or space", () => {
    // regression: Win32 strips trailing dots and spaces per component, so `.obsidian./x`
    // reached the config directory and `evil.js.` / `evil.js ` landed as `evil.js`,
    // after the extension check had read an extension the filesystem would not use.
    for (const path of [
      ".obsidian./plugins/ctrl-notes-cloud-mcp/manifest.json",
      ".obsidian /app.json",
      "notes/evil.js.",
      "notes/evil.js ",
      "notes/a.md.",
      "notes./a.md",
    ]) {
      expect(isSafeInboundPath(path), path).toBe(false);
    }
  });

  it("refuses executable extensions no deny-list remembered", () => {
    // regression: the check was a deny-list, so .scr .hta .reg .desktop .command .lnk
    // and a dozen others passed. Only an allow-list makes the header comment true.
    for (const ext of "scr hta vbe jse wsf msi reg cpl pif lnk url desktop command mts cts pyw node".split(
      " ",
    )) {
      expect(isSafeInboundPath(`notes/x.${ext}`), ext).toBe(false);
    }
  });
});

describe("classifyPath", () => {
  it.each(["a.md", "b.canvas", "c.txt"])("calls %s text", (p) =>
    expect(classifyPath(p)).toBe("text"),
  );
  it.each(["a.png", "sub/b.pdf", "c.mp4"])("calls %s an attachment", (p) =>
    expect(classifyPath(p)).toBe("attachment"),
  );
  it.each(["a.js", "b.sh", "c.EXE"])("refuses %s", (p) => expect(classifyPath(p)).toBe("refused"));
  it.each([
    "",
    "../a.md",
    "/abs.md",
    ".obsidian/x.md",
    ".Obsidian/x.md",
    "noext",
    "a.md.",
    "a\\b.md",
  ])("refuses %s structurally, before any extension rule", (p) =>
    expect(classifyPath(p)).toBe("refused"),
  );

  // regression: the plugin's floor was WIDER than the server's in three places, so these
  // paths were reported in every manifest, pushed as a full `create`, refused
  // `path_invalid` with `retry: "never"`, and re-sent on the next reconnect — forever,
  // with the user never told. `aux.md` and `9:30 standup.md` are ordinary note names.
  it.each([
    "aux.md",
    "Notes/con.md",
    "nul.md",
    "COM1.md",
    "lpt9/x.md",
    "1:1 with Bob.md",
    "9:30 standup.md",
    "no\u0085break.md",
  ])("refuses %s, which the server refuses too", (p) => expect(classifyPath(p)).toBe("refused"));

  // The reserved-name rule is on the STEM and exact: near-misses stay ordinary notes.
  it.each([
    ["CONS.md", "text"],
    ["COM0.md", "text"],
    ["COM10.md", "text"],
    ["auxiliary.md", "text"],
  ])("still accepts %s as %s", (p, kind) => expect(classifyPath(p)).toBe(kind));

  it("keeps a reserved stem in the EXTENSION position an attachment", () => {
    // `a/b.CON` has stem `b`; only the stem is reserved, so this is an ordinary
    // attachment and must not be swept up by the new rule.
    expect(classifyPath("a/b.CON")).toBe("attachment");
  });
});

describe("decodesAsText", () => {
  /**
   * The half of the floor a path cannot answer. The vault answers
   * `BatchError::NotText` for bytes that are not text at a path it PROJECTS — every note,
   * every `.base` (`projections::projects_content`) — with no `current_sha`, which
   * `retry.ts` reports rather than retries, so the same path comes back on the next scan
   * and is pushed again, forever. This is that question, asked before the round trip.
   *
   * This function answers only "do these bytes decode". Whether that answer should GATE a
   * push is the caller's, and both callers gate it on `classifyPath(path) === "text"` —
   * an attachment is sent whatever its bytes are, which is what `edit::Op::PutBytes`
   * made possible.
   *
   * **Proven able to fail**: dropping `fatal: true` from the decoder — the exact mistake
   * this guards, and what `DataAdapter.read` does — turns the four refusing cases and the
   * reuse case red (5 failed | 70 passed), while every accepting case stays green, so it
   * is these that carry the check. The try/catch has its own isolating mutation: deleting
   * it makes those same cases throw rather than return `false`, which is a different
   * failure with the same colour.
   */
  it.each([
    ["empty", new Uint8Array()],
    ["ascii", new TextEncoder().encode("filters:\n  and:\n")],
    ["multi-byte", new TextEncoder().encode("unicode-日本語 — ✓\n")],
    ["a UTF-8 BOM", new Uint8Array([0xef, 0xbb, 0xbf, 0x61])],
    ["a NUL byte, which is text as far as UTF-8 is concerned", new Uint8Array([0x61, 0x00])],
  ])("accepts %s", (_why, bytes) => {
    expect(decodesAsText(bytes)).toBe(true);
  });

  it.each([
    // What a `.txt` re-saved as UTF-16LE actually looks like: a BOM, then every ASCII
    // character followed by a NUL. The example `ALLOWED_EXTENSIONS`' comment names.
    ["UTF-16LE with a BOM", new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])],
    // Latin-1, the other everyday one: `é` as a bare 0xE9 starts a three-byte sequence
    // that never arrives.
    ["latin-1", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])],
    // A multi-byte character cut in half — a file being written while we read it.
    ["a truncated sequence", new Uint8Array([0x61, 0xe6, 0x97])],
    // The PNG signature: the byte after the magic number is not a continuation byte.
    ["png bytes", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])("refuses %s", (_why, bytes) => {
    expect(decodesAsText(bytes)).toBe(false);
  });

  it("answers the next file honestly after one that threw", () => {
    // The decoder is one shared instance. `decode()` without `{ stream: true }` resets
    // its state per call, but that is a property of the API rather than of this code, so
    // it is pinned: a scan hits this function once per file, and a decoder left poisoned
    // by a single binary file would withhold the whole vault.
    expect(decodesAsText(new Uint8Array([0xff, 0xfe]))).toBe(false);
    expect(decodesAsText(new TextEncoder().encode("still text\n"))).toBe(true);
  });
});

// The export's path rule (export design EX16) is exactly this classifier: a vault path
// is exported iff this plugin would write it to disk. The vault ports the rule
// (`exportable`) and tests it against its own copy of this table. Nothing connects the two
// copies, so a rule changed on one side only fails neither: change the table deliberately,
// in both repositories.
describe("the shared export-path cases", () => {
  const cases = (
    fixture("export-paths/cases.json") as {
      cases: { path: string; exportable: boolean; why: string }[];
    }
  ).cases;
  it("is not empty", () => {
    expect(cases.length).toBeGreaterThan(20);
  });
  it.each(cases)("$path is exportable: $exportable ($why)", ({ path, exportable }) => {
    expect(classifyPath(path) !== "refused").toBe(exportable);
  });
});

/**
 * **Every top-level dot-folder is refused, which is how a config folder is.** Obsidian
 * accepts only a config folder that starts with a dot, and each device may use its own,
 * so the rule cannot be `.obsidian` by name (`hardcoded-config-path`).
 */
describe("a top-level dot-folder is refused", () => {
  it.each([
    ".obsidian-mobile/plugins/x/data.json",
    ".Work-Config/app.json",
    ".trash/old.md",
    ".hidden.md",
  ])("%s is refused", (path) => {
    expect(classifyPath(path)).toBe("refused");
  });

  it("refuses only the top level: a dot-folder deeper down is an ordinary folder", () => {
    expect(classifyPath("notes/.hidden/x.md")).toBe("text");
  });
});
