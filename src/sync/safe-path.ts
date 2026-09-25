/**
 * The floor the plugin will not write below, whatever the server says.
 *
 * **This is not a mirror of anything server-side, and does not claim to be one** — nit
 * fix: an earlier revision of this file's comments described it as matching a `server/`
 * tree (`vault-path.ts`, a `TEXT_EXTENSIONS` constant, a `binary_as_content` refusal code,
 * a cross-repo "nesting" fuzz test) that is not part of this repository at all. This
 * plugin's OWN vault (`apps/vault/src/commands/apply_change.rs`'s `check_path`) checks a
 * much smaller, different set of things — path length, NFC normalisation, and structural
 * escapes — and has no notion of extensions, reserved names or a config directory; its
 * only line on TEXT vs. binary is by PATH: `ApplyBatchCommand` requires text exactly
 * where `projections::projects_content` says the content is projected — every note and
 * every `.base` — and stores an attachment without decoding it. (It refused EVERY upload
 * that did not decode as UTF-8 until `edit::Op::PutBytes` landed, which is why several
 * comments in this file used to say the rule was about content alone.) Every rule below
 * this comment is
 * this plugin's OWN, independent choice about what it is willing to write, on purpose:
 * inbound changes are bytes plus a path from a remote party, and the plugin hands them to
 * a filesystem — if the only guard lived on the other side of the network, then a vault
 * bug, a compromised deployment, or anything that can answer as the vault writes to
 * `.obsidian/plugins/<id>/main.js` — the plugin's own code — and executes as the
 * plugin on next load (PLUGIN §4a names the config directory for exactly this reason: "the
 * plugin's own bearer token lives there").
 *
 * Kept deliberately narrower than §4a and independent of it: this refuses anything it
 * does not positively recognise, so it stays correct without tracking that list.
 */

import { CODE_EXTENSIONS } from "./code-path.ts";

/**
 * The only extensions the plugin will write, and the only ones it will REPORT — an
 * allow-list, not a deny-list.
 *
 * A deny-list of executable extensions is a list of the ones somebody thought of.
 * `.scr`, `.hta`, `.vbe`, `.wsf`, `.msi`, `.reg`, `.cpl`, `.pif`, `.lnk`, `.url`,
 * `.desktop`, `.command`, `.pyw`, `.node` and the rest are all fine as text, all carried
 * by a `content: string` wire, and all absent from any list of that shape.
 *
 * **There is no server-side extension list this must stay under.** The vault does now
 * ask a question about the path — `projections::projects_content`, which decides whether
 * the content is PROJECTED and therefore has to be text — but that is not an allow-list
 * of what may be written: everything outside it is stored as an attachment rather than
 * refused. This list stays this plugin's own answer to a different question, which is
 * what it is willing to WRITE to a disk.
 *
 * **`base` is back, and the history of that word is worth stating exactly, because an
 * earlier revision of this comment told it wrong.** This list once carried `csv`, `json`
 * and `base`, and they were removed on the reasoning that "the server enforces no
 * extension rule at all" had been falsified. That reasoning was about **an earlier prototype's**
 * server, which really did have a `TEXT_EXTENSIONS` constant and really did answer
 * `binary_as_content` for a path outside it — and this file's own header is the record
 * that none of it is part of THIS repository. Here the sentence that was falsified there
 * was true when it was written: `apply_upload` looked at the bytes and never at the name.
 * So the extension half of that removal was inherited from a server this plugin does not
 * talk to. It has since acquired a name-shaped question of its own — `projects_content`,
 * above — but still nothing that refuses a path for its extension, so the conclusion
 * stands even though the sentence supporting it has moved.
 *
 * What survived the retraction was a second, real risk, and it was never itself measured:
 * reporting a path as `"text"` whose actual bytes are not UTF-8 (a `.txt` saved as UTF-16,
 * say), which the vault refuses — on every reconnect, forever. `txt` has carried that risk
 * this whole time. **It is not answered by narrowing this list, and it is not answered by
 * measuring somebody's two `.base` files either**: a list of extensions cannot know what
 * bytes are behind one, and an extension measured as text today is text until the next
 * time an editor writes it. It is answered one line down, by
 * {@link decodesAsText} — the bytes are checked where the bytes actually are
 * (`derive.ts` before a push, `manifest-scan.ts` before a report), and a path whose
 * content does not decode is withheld by this device rather than claimed and refused. That
 * is this file's own principle applied to content instead of names: a path this plugin
 * cannot sync cleanly is one it should not claim.
 *
 * `md`/`canvas`/`txt`/`base` is this plugin's own choice of "formats Obsidian reads and
 * writes as text". `base` is Obsidian's own YAML — an editor writes it, not a user's
 * arbitrary tool — and the vault has a whole read surface waiting on it
 * (`apps/vault/src/bases`), which is worth nothing while no `.base` file can reach it.
 *
 * **Attachments are not the way to widen it, and never were** — but the reason has
 * changed and is worth stating exactly, because this comment said the wrong one until
 * `edit::Op::PutBytes` landed. It used to read "`apply_upload` has no binary-content path
 * at all, so every attachment is refused regardless of extension", which was true and is
 * now false: the vault stores attachments.
 *
 * The rule survives its old justification. This list is "formats Obsidian reads and
 * writes as TEXT", and that is what its members are used for — `classifyPath` returns
 * `"text"` for them, which is what decides whether {@link decodesAsText} must answer yes
 * before a file leaves this device. An image is not text, is correctly classified
 * `"attachment"` already, and adding one here would relabel it rather than enable it.
 * Whether attachments sync at all is `main.ts`'s `attachments` getter, and a device that
 * holds them sends them without ever asking this list.
 */
const ALLOWED_EXTENSIONS = new Set(["md", "canvas", "txt", "base"]);

/** Win32 device names, reserved with any extension. Mirrors the server's `RESERVED`. */
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/*
 * **Every top-level dot-folder is refused**, which is how the config folder is refused.
 * Obsidian accepts only a config folder that starts with a dot (its `validateConfigDir`),
 * and devices sharing a vault may each use a different one (desktop on the default, a
 * phone on its own), so another device's config folder would otherwise sync as ordinary
 * files: its plugins' code and their `data.json` credentials. Refusing `.obsidian` by
 * name left every other one open inbound; `eslint-plugin-obsidianmd`'s
 * `hardcoded-config-path` found that (2026-09-22), and it also forbids naming the default
 * at all — the literal is a finding and disabling the rule is an error. Asking
 * `Vault#configDir` would cover this device's folder only, which this rule already does.
 *
 * Obsidian hides dot-prefixed paths from the vault anyway, so nothing a user can see or
 * edit is lost; that includes Obsidian's own `.trash`. A top-level dot-FILE goes with
 * them. The vault's export rule (export design EX16, `exportable`) is this classifier
 * ported and makes the same cut; each side tests its rule against its own copy of
 * `export-paths/cases.json` (here, under `test-fixtures/wire/`).
 */

/**
 * Every structural refusal, and it runs FIRST — before any extension rule looks at the
 * path. The config directory, an escape, a control character or a Win32-stripped trailing
 * dot is refused whatever the file is named.
 */
const isStructurallySafe = (raw: string): boolean => {
  // **Normalised FIRST.** Two of the structural rules below are POSITIONAL — the colon
  // test indexes byte 1. macOS hands Obsidian decomposed names, so `e` + U+0301 +
  // `:30 standup.md` puts the colon at index 2 for a raw check and index 1 after
  // composition — normalising first is what keeps a positional rule from depending on
  // which Unicode form the filesystem happened to hand back.
  //
  // This does NOT refuse non-NFC paths — a decomposed filename is ordinary on macOS and
  // must still sync. It only decides the structural questions on the composed form.
  const path = raw.normalize("NFC");
  if (path === "") return false;
  // Two linters read this file, both from `plugin:lint` (Biome, then
  // eslint-plugin-obsidianmd), and each needs its own directive. Biome's must be the line
  // immediately above, so eslint's goes on the line itself.
  // Through U+009F, matching the server: the C1 block (U+0080-U+009F) is control
  // characters too, and stopping at U+007F left a name the server refuses
  // `control_char` classified as syncable here — reported in every manifest, pushed,
  // and refused forever.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point — NUL truncates a path in a C API underneath.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return false; // eslint-disable-line no-control-regex -- matching control characters is the point.
  // A backslash is a separator on the platform we are least able to reason about from
  // here, so it is refused rather than normalised.
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  // The server's exact condition — ANY second-byte colon, not only a drive letter.
  // `1:1 with Bob.md` and `9:30 standup.md` are ordinary note names that the narrower
  // `/^[A-Za-z]:/` let through and the server then refused, on every reconnect.
  if (path.length >= 2 && path[1] === ":") return false;

  const parts = path.split("/");
  // Catches "", ".", "..", "a//b", "a/" and "a/./b" in one pass — every way a path can
  // name something other than what it appears to.
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  // Win32 strips trailing dots and spaces per component, so `.obsidian./x` reaches the
  // config directory and `evil.js.` lands as `evil.js` — both after the checks below
  // have inspected a name the filesystem will not actually use. The server refuses
  // these outright (`trailing_dot_or_space`); so does this.
  if (parts.some((p) => p.endsWith(".") || p.endsWith(" "))) return false;

  // Win32 reserves these names with ANY extension, so the check is on the stem — this
  // plugin's own precaution (the vault's `check_path` has no such rule; see this file's
  // own header for why that asymmetry is fine): without this, a note called `aux.md`
  // synced cleanly on every OS except the one where opening it does something else
  // entirely.
  if (parts.some((p) => RESERVED_STEM.test(p.split(".")[0]!))) return false;

  // Every top-level dot-folder or dot-file: the config folder among them (above).
  if (parts[0]!.startsWith(".")) return false;

  return true;
};

export type PathClass = "text" | "attachment" | "refused";

/**
 * Three answers, replacing the two-answer floor.
 *
 * Text is an **allow-list**, code is a **deny-list**, attachments are the **residual**.
 *
 * **Not a mirror of the vault's own `check_path`, nor a subset of it in any provable
 * sense** — nit fix: an earlier revision of this comment claimed exactly that
 * relationship, pinned by a cross-repo fuzz test that does not exist in this repository
 * (this file's own header explains why the two are independent by design). The practical
 * asymmetry that DOES matter: a path this floor allows and the vault refuses is derived,
 * hashed, pushed, and refused on every reconnect, forever (`retry.ts`'s own reasoning for
 * why a refusal with no `current_sha` is reported rather than retried). A path this floor
 * refuses that the vault would have accepted is merely not synced by this device — a
 * choice it is allowed to make, the same one mobile makes for every attachment.
 */
export const classifyPath = (path: string): PathClass => {
  if (!isStructurallySafe(path)) return "refused";
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  // No extension at all is refused: every op the wire can carry names a file, and a
  // path we cannot classify is one we should not write.
  if (dot <= 0) return "refused";
  const ext = last.slice(dot + 1).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return "text";
  if (CODE_EXTENSIONS.has(ext)) return "refused";
  return "attachment";
};

/** Kept for callers that only ask "may we write text here?". */
export const isSafeInboundPath = (path: string): boolean => classifyPath(path) === "text";

/**
 * The floor's second half: the BYTES, once there are any.
 *
 * {@link classifyPath} answers what this plugin is willing to claim from the name alone,
 * which is all a name can tell you. This answers whether it can honour the claim. They
 * are deliberately separate functions — a path is classified in four places that have no
 * content in hand (the manifest filter, the reconcile plan, the shell's seed, the inbound
 * write), and only two of those ever hold bytes.
 *
 * **Exactly the vault's own question, asked before the round trip rather than after —
 * and now, like the vault's, only where the content is PROJECTED.** The vault answers
 * `BatchError::NotText` for bytes that are not text at a path
 * `projections::projects_content` covers (every note, every `.base`), and stores anything
 * else as an attachment. A push refused for that reason carries no `current_sha`, so
 * `retry.ts` reports it rather than retrying — and the next manifest scan reports the same
 * path, and the next reconnect pushes it again. Forever, and with nothing on disk changed
 * to break the loop. Asking here means the device withholds the path instead: one warning
 * to the user (`derive.ts`'s `undecodable`, surfaced by `main.ts`) and nothing sent.
 *
 * **Callers gate this on `classifyPath(path) === "text"`, and must keep doing so.** This
 * function answers only "do these bytes decode"; asking it of an attachment and acting on
 * `false` is how every image was withheld before attachments landed. The asymmetry stays
 * the safe way round either way: this plugin is STRICTER than the vault for `txt`, `json`,
 * `canvas` and `csv`, which the vault does not project and would therefore accept as
 * bytes, and a path this device withholds is merely not synced — the reverse is a push
 * refused on every reconnect forever.
 *
 * `fatal: true` is the whole of it: a non-fatal `TextDecoder` — which is what
 * `DataAdapter.read` hands back, and why nothing in the sync path reads text through it
 * any more — replaces every bad sequence with U+FFFD and returns a string that encodes
 * back to valid UTF-8. That does not refuse; it silently rewrites the user's file and
 * pushes the rewrite as authoritative, which is worse than the loop it looks like it
 * avoids.
 *
 * One decoder, reused: `decode()` without `{ stream: true }` resets its state per call, so
 * a throw on one file cannot poison the next.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export const decodesAsText = (bytes: Uint8Array): boolean => {
  try {
    STRICT_UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};
