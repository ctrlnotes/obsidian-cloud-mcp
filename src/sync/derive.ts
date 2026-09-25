import { MAX_FRAME_BYTES } from "../wire.ts";
import { bytesHash } from "./hash.ts";
import { classifyPath, decodesAsText } from "./safe-path.ts";

/**
 * What the vault told us happened since the last settle.
 *
 * Paths, never contents: the events are only a hint about *where* to look. What is
 * actually sent is decided by comparing disk against `state.hashes`, which is what makes
 * the whole thing idempotent and echo-proof.
 */
export interface Touched {
  /** Created or modified. */
  readonly dirty: ReadonlySet<string>;
  /** Observed `delete` events — never absence (§6a). */
  readonly deleted: ReadonlySet<string>;
  /** newPath → oldPath. */
  readonly renamed: ReadonlyMap<string, string>;
}

/** Just enough of the vault to read a file: its size, and its bytes. */
export interface ReadableFiles {
  /**
   * **The only content accessor, for text as much as for an attachment.** There was a
   * `read(path): Promise<string | null>` beside this one and nothing in the sync path
   * calls it any more: Obsidian's own `DataAdapter.read` decodes non-fatally, so it
   * cannot tell text from bytes that merely survive being mangled into it.
   */
  readBinary(path: string): Promise<Uint8Array | null>;
  /**
   * Metadata only — the whole reason an oversized file is never read.
   *
   * Mirrors `ScannableVault` in `manifest-scan.ts`, which has always stat'ed first. This
   * path did not, so a device discovered a file was too large by buffering all of it —
   * the hazard `wire.ts` names where it declares `MAX_FRAME_BYTES`.
   */
  stat(path: string): Promise<{ size: number } | null>;
}

/**
 * A change ready to leave this device — **ours, not an earlier prototype's `Change` union.**
 *
 * One write op, not four: an earlier prototype's wire distinguished `create`/`replace` (text, inline
 * content) from `create_binary`/`replace_binary` (an attachment, content addressed by hash
 * alone, fetched separately). Ours has no such split — `Up::Put` names a path, a `base_sha`
 * and a `sha`, and the bytes follow as binary frames regardless of what kind of file they
 * are (design §8.2) — so `put` covers both, and `content` is always bytes: UTF-8 for text,
 * raw for an attachment. `patch` is dropped outright (design §3.2): our vault merges (§9)
 * and never asks a client to apply a diff.
 *
 * `base: null` is a create; `base: <hash>` is a replace against that ancestor — the same
 * distinction an earlier prototype made with an absent field, spelled the way our wire already spells
 * `base_sha` everywhere else (`wire.ts`'s `UpPut`).
 */
export type Change =
  | {
      readonly op: "put";
      readonly path: string;
      readonly base: string | null;
      readonly content: Uint8Array;
      readonly hash: string;
    }
  | { readonly op: "delete"; readonly path: string; readonly base: string }
  | { readonly op: "rename"; readonly path: string; readonly from: string; readonly base: string };

/**
 * What a derive decided: the changes to send, and the paths it refused to send.
 *
 * `oversize` and `undecodable` are returned rather than logged because this function is
 * pure (P3) and because the shell has to TELL the user — a file silently absent between
 * reconnects is the failure this whole issue is about.
 */
export interface DeriveResult {
  readonly changes: Change[];
  readonly oversize: string[];
  /**
   * Paths whose bytes are not UTF-8, and so were not sent — whatever they are named.
   *
   * Returned for exactly the reason `oversize` is, and it is the same failure the vault
   * would otherwise answer with a refusal this device cannot act on: `safe-path.ts`'s
   * `decodesAsText` has the whole argument.
   */
  readonly undecodable: string[];
}

export interface DeriveOptions {
  /**
   * Whether this device holds attachments at all (mobile does not).
   *
   * Absent means it does, mirroring the wire's own default: a device that says nothing is a
   * device that holds everything.
   */
  readonly attachments?: boolean;
}

/**
 * **A path this device may carry at all** — the one definition, called from all four
 * places that used to write it out.
 *
 * Text always; attachments only where the device holds them; a code or script path never,
 * on either side of a rename (PLUGIN §4a). This predicate is what PLUGIN §2's "the plugin
 * makes **no reconciliation decisions**" rests on: it is only true while the manifest
 * scan, the derive, the reconcile plan and the shell's own filter agree about what this
 * device carries. They were four copies held together by a comment, and one drifting copy
 * is a file that appears in the manifest, comes back in `push`, and is never sent —
 * forever, and with nothing logged. `safe-path.ts` records the last time that shipped.
 *
 * **Not in `safe-path.ts`.** That module is deliberately independent of §4a and imports
 * only `code-path.ts`; `attachments` is a DEVICE PREFERENCE, not a security fact, and
 * folding it in would give the write floor a parameter that can turn it off.
 *
 * `attachments` is required rather than defaulted, on purpose: a default here is how the
 * four copies came to disagree about mobile in the first place.
 */
export const syncablePath = (path: string, attachments: boolean): boolean => {
  const kind = classifyPath(path);
  return kind === "text" || (kind === "attachment" && attachments);
};

/**
 * Turn "these paths moved" into the changes the wire wants.
 *
 * **`base` is always our last-synced hash**, never the hash of what is on disk now. The
 * vault resolves a stale `base` through its own merge (§9) and quoting our current bytes
 * would name something it never held, and reject with no `current_sha` to reconcile
 * against.
 *
 * **Renames come first.** A rename plus an edit to the same file is two changes, and the
 * vault has to move the file before it is asked to write to the new path.
 */
export const deriveChanges = async (
  files: ReadableFiles,
  hashes: Readonly<Record<string, string>>,
  touched: Touched,
  options: DeriveOptions = {},
): Promise<DeriveResult> => {
  const attachments = options.attachments ?? true;
  /** Paths skipped because the vault will not buffer an upload this large (`MAX_FRAME_BYTES`). */
  const oversize: string[] = [];
  /** Paths whose bytes are not text, which this device withholds rather than claim. */
  const undecodable: string[] = [];
  const syncable = (path: string): boolean => syncablePath(path, attachments);

  const renames: Change[] = [];
  const deletes: Change[] = [];
  const writes: Change[] = [];
  /** Paths whose `base` was established by a rename earlier in this batch. */
  const rebased = new Map<string, string>();
  /**
   * Sources a rename empties. Their last-synced hash is no longer AT that path once the
   * rename lands, and renames are sent first — so a new file created at the vacated path
   * in the same window is a `create`. Quoting the retired hash was a `replace` against a
   * base nothing holds there, which the vault cannot resolve and rejects outright.
   */
  const retired = new Set<string>();

  for (const [to, from] of touched.renamed) {
    // A rename that is only a RE-SPELLING is not a rename. Both sides reach here already
    // normalised (`main.ts` normalises at the listener), so `café.md` decomposed renamed
    // to `café.md` composed collapses to one path. Sending it emits `{from: X, path: X}`,
    // whose result then retires the very base it just set — `forget` is applied after the
    // hashes are merged — and the next edit derives as a `create` and earns a conflict copy.
    if (to === from) continue;
    if (!syncable(to) || !syncable(from)) continue;
    const base = hashes[from];
    // A rename of something the vault never had is not a move, it is a new file — and
    // `rename` carries no content, so sending one would create an empty path.
    if (base === undefined) continue;
    renames.push({ op: "rename", path: to, from, base });
    rebased.set(to, base);
    retired.add(from);
  }

  /** Touched paths we found on disk — a deletion of one of these was undone. */
  const alive = new Set<string>();

  // Sequential on purpose, and bounded on purpose: reads and hashes run one at
  // a time, which is fine for a handful of edited notes and would not be for a whole
  // vault. Registering the listeners inside `onLayoutReady` is what keeps the whole vault
  // out of `dirty` in the first place — without it this loop is the startup cost.
  for (const path of touched.dirty) {
    if (!syncable(path)) continue;
    const base0 = (): string | undefined =>
      rebased.get(path) ?? (retired.has(path) ? undefined : hashes[path]);

    // **A per-path filesystem error must not strand every other dirty path in this
    // settle.** `stat`/`readBinary` already return `null` for "gone before we
    // looked" (§6a, handled below); a THROW — a folder removed mid-scan, a permission
    // error, the same race `apply.ts`'s `applyReplay` catches on the inbound side — used to
    // escape this whole function uncaught, and the SHELL awaited it with `touched` already
    // emptied, losing every other path in the batch along with the one that failed.
    try {
      // **Stat before read, for every path — text and attachment alike.** `MAX_FRAME_BYTES`
      // is a memory bound on the vault's own connection handler (`Upload::begin` refuses a
      // declared size past it before allocating), and unlike an earlier prototype's wire it applies to
      // everything a `put` can carry, not to attachments alone. Reading first means a large
      // file is fully buffered and hashed before anyone asks whether it can be sent at all.
      const stat = await files.stat(path);
      if (stat === null) continue; // Gone before we looked. Absence is never a deletion (§6a).
      // **Alive as soon as it is seen**, before any decision about whether we can SEND it. A
      // successful `stat` is proof the file is on disk, and that is the whole question `alive`
      // answers. Setting it only after a successful read let the oversize branch below skip
      // it, so a delete-then-create window emitted a `delete` for a file sitting on disk — and
      // the vault propagated that deletion to every other device.
      alive.add(path);
      if (stat.size > MAX_FRAME_BYTES) {
        oversize.push(path);
        continue;
      }

      // **Bytes, for text and attachments alike** — this used to read a text path
      // through `read`, which is `DataAdapter.read`, which is a NON-fatal decode. A file
      // whose bytes are not UTF-8 came back as a string full of U+FFFD, encoded back to
      // valid UTF-8, and was pushed as this device's authoritative content: the vault
      // accepted it and every other device got the rewrite. Reading the bytes is what
      // makes `decodesAsText` possible at all, and it also means what leaves this device
      // is what is on the disk, byte for byte, which is what the vault hashes.
      const bytes = await files.readBinary(path);
      if (bytes === null) continue; // Gone before we looked, same as above.
      // The bytes decide, and the name has no vote. Withheld — not sent, and so never
      // refused on every reconnect for as long as the file exists. `safe-path.ts`'s
      // `decodesAsText` carries the reasoning; this is returned rather than logged for the
      // same reason `oversize` is (P3, and the shell tells the user).
      //
      // **Conditional again, and the condition is the vault's own.** This was
      // unconditional while `apply_upload` ran `String::from_utf8` over EVERY completed
      // upload: gating on the extension then would have made this device push a file the
      // vault must refuse — refused with no `current_sha`, so `retry.ts` reports rather
      // than retries, and the next reconnect does it again.
      //
      // The vault now decides by PATH instead: `ApplyBatchCommand`'s `Op::PutBytes`
      // requires text exactly where `projections::projects_content` says the content is
      // projected — a note or a `.base` — and stores an attachment without decoding it.
      // So this mirrors that rule rather than the old blanket one, and the asymmetry
      // `safe-path.ts` warns about stays the safe way round: a path this device withholds
      // is merely not synced, while a path it pushes and the vault refuses would be
      // refused forever.
      //
      // A note whose bytes are not text is still withheld, not sent. The vault would
      // answer `BatchError::NotText`, and withholding says the same thing without
      // spending a round trip on it every reconnect.
      if (classifyPath(path) === "text" && !decodesAsText(bytes)) {
        undecodable.push(path);
        continue;
      }
      const hash = await bytesHash(bytes);

      const base = base0();
      // Already in step. This is the echo the inbound path would otherwise generate.
      if (base !== undefined && base === hash) continue;
      writes.push({ op: "put", path, base: base ?? null, content: bytes, hash });
    } catch (e) {
      console.warn(`Ctrl Notes: could not read ${path} while deriving this settle's changes`, e);
    }
  }

  for (const path of touched.deleted) {
    if (!syncable(path)) continue;
    // Deleted and then written again inside one window — how several editors replace a
    // file atomically. It is on disk now, so pushing the delete would destroy a live file
    // vault-side, and nothing would be dirty next settle to put it back.
    if (alive.has(path)) continue;
    const base = hashes[path];
    if (base === undefined) continue;
    deletes.push({ op: "delete", path, base });
  }

  // Renames first: the vault has to move a file before it is asked to write to it.
  return { changes: [...renames, ...deletes, ...writes], oversize, undecodable };
};
