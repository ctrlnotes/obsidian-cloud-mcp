import type { DownEvent, SnapshotEntry } from "../wire.ts";
import type { DeriveOptions } from "./derive.ts";
import { bytesHash } from "./hash.ts";
import { planSnapshot } from "./reconcile.ts";
import { classifyPath } from "./safe-path.ts";

/**
 * Put an inbound change on disk (design §5).
 *
 * What this returns is the point: for every path it touched, **the hash it computed from
 * the bytes it actually wrote** — which becomes that path's `base` on the next push.
 *
 * It is never the `sha` a frame carried. Recording the vault's claim would make a write
 * that silently differed invisible until the next push presented a `base` the vault does
 * not recognise.
 */
export interface VaultFiles {
  /** Nothing inbound reads a file's content; this is here for the outbound half of the
   * same object (`ReadableFiles`), which explains why there is no `read` beside it. */
  readBinary(path: string): Promise<Uint8Array | null>;
  /**
   * **The only way anything is written, text and attachment alike.** Must create missing
   * parent folders (see `main.ts`'s `mkdirp`).
   *
   * There was a `write(path, content: string)` beside this one, used for every text path,
   * and it is gone for the reason {@link fetchAndWrite} states: a string cannot express
   * the bytes the vault holds, and a device that writes a re-encoding of one has a ledger
   * that disagrees with the vault forever.
   */
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * To the vault's `.trash`, NEVER a permanent delete.
   *
   * §4 chose "edit beats delete" on the asymmetry of regret: re-deleting is trivial,
   * un-deleting may be impossible. A local file destroyed because a remote party said so
   * is that asymmetry landing on the user, and `DataAdapter` has `trashLocal` sitting
   * right beside `remove`.
   */
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * Is anything at `path`?
   *
   * **`caseSensitive` must match the operation the answer guards.** Obsidian
   * resolves `trashLocal`, `rename` and `readBinary` through the host
   * filesystem, which on APFS and NTFS is case-insensitive. So a check that
   * guards one of those asks the same way (`false`), or the two disagree: a
   * `delete` of `Notes/a.md` with `notes/a.md` on disk would be counted done
   * while the file stayed. The ONE case-sensitive question is a rename's
   * source, where a device that just performed `foo.md` → `Foo.md` must not be
   * told its own source is still there.
   */
  exists(path: string, caseSensitive: boolean): Promise<boolean>;
}

/** `hash: null` means nothing is at that path any more. */
export interface Applied {
  readonly path: string;
  readonly hash: string | null;
}

/**
 * How the bytes a `sha` names are obtained.
 *
 * **Ours, not glass-1's.** Their `fetchBytes` served one purpose — an attachment, because
 * text rode inline on the `Change` itself. Ours serves every inbound write: design §8.1 is
 * explicit that an event carries a sha and never content, so text and attachments are
 * fetched identically here. The actual transport (Task 9/10) is not this module's concern.
 */
export interface ApplyDeps {
  /**
   * `permanent` is what separates "this will never arrive" from "try again".
   *
   * A `no_blob` from the vault is permanent: the sha was never held, or has
   * been collected. Anything else — a dead socket, a timeout — is transient.
   * Conflating them gives either a device that retries forever or one that
   * abandons content it could still have had, and BOTH failure modes are ones
   * this file's ack boundary would otherwise turn into a stuck cursor.
   */
  fetchBytes(
    sha: string,
  ): Promise<{ ok: true; value: Uint8Array } | { ok: false; code: string; permanent?: boolean }>;
  /**
   * One file has landed on disk. Called IMMEDIATELY, not at the end of the batch.
   *
   * **This is what stops the plugin fighting itself.** Writing a file makes the
   * host's watcher fire, which marks the path dirty, which makes the settle
   * loop derive a change for it — and `derive` decides by comparing the file's
   * hash against the ledger. So until the ledger knows about a write, that
   * write looks exactly like a local edit and gets pushed straight back up.
   *
   * Measured before this existed: a fresh device applying a 332-file snapshot
   * pushed 102 of them back and was refused ("that path already exists and
   * needs base_sha") — and the resulting upload storm starved the `want`
   * requests on the same socket until they timed out at 30s, stalling the sync
   * at 138 files. Reporting per file rather than per batch closes the window to
   * the gap between one write and the next line of code.
   */
  onApplied?(applied: Applied): void;
  /**
   * The vault will never supply the content for `path` — design O3.
   *
   * Called once per path, at the moment a fetch comes back `permanent`, which
   * is the only place that fact is known. The cursor still advances: the
   * content is gone, waiting cannot bring it back, and withholding the ack is
   * what turns one lost file into a device that re-snapshots forever
   * (`applySnapshot` says the same in its own words).
   *
   * **Advancing past it is right and silent was not.** Until this existed the
   * only report was a `console.warn`, which no Obsidian user opens: a note the
   * vault had lost simply never appeared, the status line said "up to date",
   * and both statements were true. That is the gap O3 names — "nothing says
   * WHICH path, or that it is permanent rather than pending".
   *
   * The reason travels with it because the vault's own word is more use than
   * this plugin's guess; today it is always `unknown`
   * (`vault::sync::wire::no_blob`), and the wire is free to add others.
   */
  onUnavailable?(path: string, reason: string): void;
  /**
   * This device's ledger — the version of each path it last synced — read
   * fresh at each call. **What makes an unpushed local edit visible at all**:
   * a file whose bytes differ from its ledger entry holds a change this device
   * has not uploaded yet, and no inbound event may write or remove it
   * ({@link heldLocally}). Absent in callers that never touch disk, and then
   * nothing is treated as held.
   */
  ledger?(): Readonly<Record<string, string>>;
  /**
   * An inbound change was NOT applied to `path` because the file holds an
   * unpushed local edit. The caller must make sure that edit is uploaded —
   * it is the only way the two versions meet, in the vault's three-way merge
   * against the base the device declares (`merge::ancestor_for_upload`).
   */
  onKept?(path: string): void;
}

/**
 * **Does `path` hold a change this device has not uploaded?** True when the
 * file exists and its bytes differ from the ledger entry — including a file
 * the ledger has never heard of.
 *
 * This is the whole defence against the data loss measured on 2026-09-22
 * (plugin design §5): an inbound `put` rewrote the file, an inbound `delete`
 * trashed it, and an edit made offline — or saved inside the settle window
 * before an inbound change landed — was gone from both ends with the status
 * line reading "up to date". Leaving the file alone and uploading it instead
 * hands the two versions to the vault, which merges them against the exact
 * base the device declares, or keeps both in a conflict file (MG3).
 */
const heldLocally = async (
  vault: VaultFiles,
  path: string,
  deps: ApplyDeps,
): Promise<{ held: boolean; hash: OnDisk }> => {
  // No ledger means nothing is guarded — and nothing was looked at, so the
  // hash is `undefined` ("ask nothing"), never `null` ("nothing there").
  if (deps.ledger === undefined) return { held: false, hash: undefined };
  const bytes = await vault.readBinary(path);
  if (bytes === null) return { held: false, hash: null };
  const hash = await bytesHash(bytes);
  return { held: hash !== deps.ledger()[path], hash };
};

/** Leave `path` alone and make sure its local edit is uploaded. */
const keep = (path: string, why: string, deps: ApplyDeps): void => {
  console.warn(`Ctrl Notes: kept the local edit to ${path} rather than ${why}; uploading it`);
  deps.onKept?.(path);
};

/**
 * Bring `path` to the vault's version after a push the vault merged, or
 * answered with a conflict: the reply names what the path holds NOW, and the
 * disk still holds what was pushed. **Only while the disk still holds exactly
 * that** — a later edit is newer than both, and its own upload will
 * reconcile it.
 */
export const pullIfUnchanged = async (
  vault: VaultFiles,
  path: string,
  pushed: string,
  vaultSha: string,
  deps: ApplyDeps,
): Promise<Applied | "gone" | null | "moved-on"> => {
  if (!(await stillHolds(vault, path, pushed))) return "moved-on";
  return fetchAndWrite(vault, path, vaultSha, deps, pushed);
};

/**
 * `"gone"` — the vault will never supply this; `"moved-on"` — the disk
 * changed while the bytes were being fetched, so nothing was written; `null`
 * — transient.
 */
type Written = Applied | "gone" | "moved-on" | null;

/**
 * What the disk must still hold at the moment of writing: a hash, or `null`
 * for "nothing there". `undefined` asks nothing.
 */
type OnDisk = string | null | undefined;

/** Does `path` still hold `expect`? Read at the last moment before a write. */
const stillHolds = async (vault: VaultFiles, path: string, expect: OnDisk): Promise<boolean> => {
  if (expect === undefined) return true;
  const bytes = await vault.readBinary(path);
  if (bytes === null) return expect === null;
  return expect !== null && (await bytesHash(bytes)) === expect;
};

/**
 * Fetch `sha`'s bytes and write them at `path` — **the bytes, whatever `classifyPath` says
 * the path is.**
 *
 * **The two halves of the wire must hash the same bytes, and this is the half that used to
 * not.** `derive.ts` reads a text path with `readBinary` and pushes exactly what is on disk
 * (`bytesHash`), so the vault stores, and addresses by, the file's real bytes. This function
 * had a text branch that decoded with a NON-fatal `new TextDecoder()`, wrote the string, and
 * recorded `contentHash(string)` — and a `TextDecoder` without `{ ignoreBOM: true }` STRIPS a
 * leading U+FEFF. So a `.md` beginning `ef bb bf`, which is an ordinary Windows- or
 * editor-authored note and which `decodesAsText` correctly accepts (`String::from_utf8`
 * accepts it too), landed on disk without its BOM and was recorded under the hash of the
 * stripped text. Measured on `ef bb bf` + `hello\n`: the vault addresses it as
 * `42c1e65b…`, the ledger recorded `5891b5b5…` (the sha of `hello\n` alone). Three
 * consequences, all permanent, none logged — `planSnapshot` compares
 * `hashes[path] !== sha`, so the path is in `fetch` on EVERY snapshot forever and the user's
 * file is silently rewritten each time; the two devices differ byte for byte; and the next
 * local edit pushes a `base` the vault does not hold and earns a conflict copy.
 *
 * A non-fatal decode also does the thing `safe-path.ts`'s `decodesAsText` exists to stop —
 * it replaces bad sequences with U+FFFD and writes the rewrite as authoritative — one
 * function away from the guard, on the write side. There is now no decoder here at all,
 * which is the only shape in which "what leaves a device is what arrives" is true rather
 * than nearly true.
 *
 * `classifyPath` is still consulted, one level up in {@link applyEvent}, for `"refused"`.
 * It has no say in HOW a path is written any more, because there is only one way.
 */
const fetchAndWrite = async (
  vault: VaultFiles,
  path: string,
  sha: string,
  deps: ApplyDeps,
  expect?: OnDisk,
): Promise<Written> => {
  const fetched = await deps.fetchBytes(sha);
  if (!fetched.ok) {
    console.warn(`Ctrl Notes: could not fetch the content for ${path}: ${fetched.code}`);
    if (fetched.permanent === true) {
      // The single point at which "never arriving" is known, so the single
      // place it is reported (O3). Both callers — the snapshot loop and the
      // replay's `put` — reach `"gone"` through here.
      deps.onUnavailable?.(path, fetched.code);
      return "gone";
    }
    return null;
  }

  // **Content is addressed by its own hash, so check it.** Without this, bytes
  // that do not match what was asked for are written to disk AND recorded in
  // the ledger under their own hash — and the next derive then reads that as a
  // local edit and pushes the corruption back up as authoritative. One `if`
  // stops a bad frame becoming the vault's content.
  //
  // TRANSIENT, not permanent: a mismatch means the transport or the vault
  // misbehaved on this attempt, and a retry may well succeed. Treating it as
  // permanent would abandon content that is very likely still there.
  const actual = await bytesHash(fetched.value);
  if (actual !== sha) {
    console.warn(`Ctrl Notes: refusing ${path}: asked for ${sha}, the bytes hash to ${actual}`);
    return null;
  }
  // **Checked again here, after the fetch, not only before it.** The fetch is
  // a network round trip, and a save the user makes inside it is exactly the
  // unpushed edit PL9 exists to protect — a check made before the fetch alone
  // would overwrite it (review of #168). The window left is the gap between
  // this read and the write below, with no await of the network in it.
  if (!(await stillHolds(vault, path, expect))) return "moved-on";
  await vault.writeBinary(path, fetched.value);
  // The hash of the bytes we actually wrote, never the `sha` the frame claimed — the
  // rule this file's header states. Byte-identical to what `derive.ts` would compute for
  // the same file, which is the property the whole comment above is about.
  const applied = { path, hash: await bytesHash(fetched.value) };
  deps.onApplied?.(applied);
  return applied;
};

/**
 * {@link fetchAndWrite}, unless `path` already holds exactly `sha`'s bytes —
 * which is what a rename onto an occupied destination usually finds when it
 * is this device's own echo, and a fetch there is a round trip for nothing.
 * The hash recorded is still the one computed from the bytes on disk.
 */
const writeUnlessHeld = async (
  vault: VaultFiles,
  path: string,
  sha: string,
  deps: ApplyDeps,
): Promise<Written> => {
  const held = await vault.readBinary(path);
  const heldHash = held === null ? null : await bytesHash(held);
  if (heldHash === sha) {
    const applied = { path, hash: sha };
    deps.onApplied?.(applied);
    return applied;
  }
  return fetchAndWrite(vault, path, sha, deps, heldHash);
};

/**
 * What became of one event from a **replay** — the distinction `pump.ts`'s ack boundary
 * (write-surface design §8.3) actually needs.
 *
 * **`"skipped"` and `"unavailable"` are NOT the same failure, and conflating them is the
 * blocker this type exists to fix.** `"skipped"` is a decision this build has already made
 * for good, and will make identically every time it sees this event again: a path the
 * write floor refuses, an event `kind` this build has never heard of, a `put` naming no
 * `sha` at all. Acking past a `"skipped"` event costs nothing — redelivering it changes
 * nothing. `"unavailable"` means this build WANTED to apply the event and could not, because
 * the content is not reachable right now (today, always — write-surface design §8.1's fetch
 * frame does not exist yet) or the filesystem itself refused. Acking past an `"unavailable"`
 * event is the one thing that must never happen: it claims a change durable that was never
 * actually written, and nothing rescans to recover it (see `manifest-scan.ts`'s own gap).
 */
type EventOutcome =
  /** `also` is a SECOND ledger entry the same event produced — a rename's
   * vacated source path. Without it the old path keeps its hash in the ledger,
   * and the next derive reads a file that is gone as an unpushed local
   * deletion. */
  | { readonly status: "applied"; readonly result: Applied; readonly also?: Applied }
  | { readonly status: "skipped" }
  | { readonly status: "unavailable" }
  /**
   * The vault says this content is permanently gone.
   *
   * **Acked past, deliberately, and it is the one case that looks like it
   * should not be.** `"unavailable"` must never be acked past because retrying
   * recovers it; this cannot be recovered by anything, ever, so refusing to ack
   * would stop the cursor for the life of the device — trading a recoverable
   * gap for a permanent stall. The path is left absent and, critically, is NOT
   * written to the ledger, so a later event carrying the same path with a
   * different sha still fetches.
   */
  | { readonly status: "gone" };

/** An inbound delete of `path`, or a rename that takes it out of what this device syncs. */
const applyDelete = async (
  vault: VaultFiles,
  path: string,
  deps: ApplyDeps,
): Promise<EventOutcome> => {
  // **Nothing there is this event already applied, not a failure.** The
  // vault echoes this device's own write back to the connection that
  // authored it (`pump.ts`'s `applied` branch says why), so a delete this
  // device performed arrives with the file already gone — and Obsidian's
  // `trashLocal` throws `ENOENT` rather than shrugging. A throw withholds
  // the ack, so the cursor stopped at the event before it and every
  // reconnect replayed the same failure. Measured 2026-09-22.
  if (!(await vault.exists(path, false))) {
    deps.onApplied?.({ path, hash: null });
    return { status: "applied", result: { path, hash: null } };
  }
  // **Edit beats delete** (design §4): the asymmetry of regret. The file
  // stays; the ledger learns the vault holds nothing there, so the edit
  // uploads as a new file and brings the path back.
  if ((await heldLocally(vault, path, deps)).held) {
    keep(path, "trashing it for an inbound delete", deps);
    deps.onApplied?.({ path, hash: null });
    return { status: "applied", result: { path, hash: null } };
  }
  await vault.trash(path);
  deps.onApplied?.({ path, hash: null });
  return { status: "applied", result: { path, hash: null } };
};

/**
 * Apply one event from a **replay** — never inventing a deletion (rule 2).
 *
 * A replay is a sequence of things that happened; each frame says what to do and this
 * applies exactly that, nothing more. `"skipped"` for a frame this build cannot act on:
 * `kind` is a bare string on the wire on purpose (forward-compatible, like `readDownFrame`
 * treats an unknown frame TYPE) — a `kind` this build has never heard of is logged and
 * skipped rather than guessed at.
 *
 * **`rename` moves the old path to the new one**, using `from` — the field the frame
 * gained when deletes and renames were wired up. Before it existed this function had no
 * rename case at all, and a rename arrived as an unactionable event that left the old
 * path behind on every other device.
 */
const applyEvent = async (
  vault: VaultFiles,
  event: DownEvent,
  deps: ApplyDeps,
): Promise<EventOutcome> => {
  // Refused on this device even though the vault refuses these paths too: the only guard
  // that protects this filesystem is the one running beside it (design §4a, PL2). A
  // decision this build will make the same way forever — safe to ack past.
  if (classifyPath(event.path) === "refused") {
    // **A rename OUT of what this device syncs is a delete here**, when its source is
    // something this device holds: skipping it left the source on disk and in the ledger,
    // and an edit made before a snapshot reconcile trashed it uploaded it again as a new
    // file — two copies in the vault. The delete keeps its own rules (edit beats delete).
    if (event.kind === "rename" && event.from !== null && classifyPath(event.from) !== "refused")
      return applyDelete(vault, event.from, deps);
    return { status: "skipped" };
  }

  switch (event.kind) {
    case "put": {
      if (event.sha === null) {
        console.warn(`Ctrl Notes: a "put" event for ${event.path} named no sha; skipping`);
        return { status: "skipped" };
      }
      const local = await heldLocally(vault, event.path, deps);
      if (local.hash === event.sha) {
        // Already on disk — this device's own write echoed back, most often.
        // Recorded, not rewritten: a rewrite of identical bytes still fires
        // the host's watcher for nothing.
        const applied = { path: event.path, hash: event.sha };
        deps.onApplied?.(applied);
        return { status: "applied", result: applied };
      }
      if (local.held) {
        keep(event.path, "overwriting it with an inbound change", deps);
        return { status: "skipped" };
      }
      const result = await fetchAndWrite(vault, event.path, event.sha, deps, local.hash);
      if (result === "moved-on") {
        keep(event.path, "overwriting a save made while its replacement was fetched", deps);
        return { status: "skipped" };
      }
      if (result === null) return { status: "unavailable" };
      if (result === "gone") return { status: "gone" };
      return { status: "applied", result };
    }
    case "delete":
      return applyDelete(vault, event.path, deps);
    case "rename": {
      if (event.from === null) {
        // The vault should never send one without it, but a frame this build
        // cannot act on is skipped rather than guessed at — inventing a source
        // path would move the wrong file.
        console.warn(`Ctrl Notes: a "rename" event to ${event.path} named no source; skipping`);
        return { status: "skipped" };
      }
      // Both ends refused on this device even though the vault refuses them
      // too: the only guard protecting this filesystem is the one beside it.
      if (classifyPath(event.from) === "refused") return { status: "skipped" };
      if (event.sha === null) {
        // Unreachable from this vault — `events.rs` declares `Change::Rename`'s
        // `content_sha` as a `String`, not an `Option` — and handled anyway,
        // the way the `put` case above handles its own missing sha. Accepting
        // it would mean recording `hash: null` for a file that exists, which
        // makes the ledger forget something on disk and earns a refusal on the
        // next push.
        console.warn(`Ctrl Notes: a "rename" event to ${event.path} named no sha; skipping`);
        return { status: "skipped" };
      }
      // **Four cases, because Obsidian's adapter throws for two of them and a
      // throw withholds the ack.** The source is asked about CASE-SENSITIVELY
      // (see `VaultFiles.exists`): a device that just renamed `foo.md` →
      // `Foo.md` on APFS or NTFS would otherwise be told its source is still
      // there.
      const sourceHere = await vault.exists(event.from, true);
      const destHere = await vault.exists(event.path, false);
      if (!sourceHere) {
        if (destHere) {
          // The move has already happened here — this device's own rename
          // echoed back. The destination's content decides only what the
          // LEDGER says about it: the bytes the event names are recorded, and
          // anything else — a later edit, or later events already applied
          // while this one was held — is left for those later events to
          // record. Neither shape can ever be retried into something else, so
          // neither may hold the ack: the destination is never going to hash
          // to this rename's sha again once it has moved on.
          const landed = await vault.readBinary(event.path);
          if (landed !== null && (await bytesHash(landed)) === event.sha) {
            deps.onApplied?.({ path: event.path, hash: event.sha });
            deps.onApplied?.({ path: event.from, hash: null });
            return {
              status: "applied",
              result: { path: event.path, hash: event.sha },
              also: { path: event.from, hash: null },
            };
          }
          deps.onApplied?.({ path: event.from, hash: null });
          return { status: "applied", result: { path: event.from, hash: null } };
        }
        // Neither path is here. Nothing to move, and no retry can change that
        // — a device that never held the file, or one whose content the vault
        // has since lost (`"gone"`). Withholding the ack would stop this
        // device's cursor for good, which is the trade `EventOutcome` argues
        // against in as many words.
        console.warn(
          `Ctrl Notes: a "rename" to ${event.path} found neither path on disk; skipping`,
        );
        return { status: "skipped" };
      }
      if (destHere) {
        // Both here, which the vault emits: `pure::decide` checks only the
        // SOURCE, so `a.md → b.md` is recorded over an existing `b.md`.
        // Obsidian refuses to rename onto an existing path, so as a move this
        // throws — and the local destination never goes away, so every
        // reconnect repeats it. Write the content the event names instead.
        // The destination's own unpushed edit is not overwritten either: it
        // stays, keeps its ledger entry, and uploads against that base.
        const dest = await heldLocally(vault, event.path, deps);
        if (dest.held && dest.hash !== event.sha) {
          keep(event.path, "overwriting it with an inbound rename", deps);
          // The source goes only if it holds what moved. If it holds an edit
          // of its own, it stays and its ledger entry is cleared below, so it
          // uploads as a NEW file at the old path: an edit outlives a rename
          // the same way it outlives a delete (design §4), and the vault
          // holds the moved content at the destination either way.
          const source = await vault.readBinary(event.from);
          if (source !== null && (await bytesHash(source)) === event.sha) {
            await vault.trash(event.from);
          }
          deps.onApplied?.({ path: event.from, hash: null });
          return { status: "applied", result: { path: event.from, hash: null } };
        }
        const written = await writeUnlessHeld(vault, event.path, event.sha, deps);
        if (written === "moved-on") {
          // Saved while the destination's new content was fetched: the save
          // is newer than both, and uploads against the base it had.
          keep(event.path, "overwriting a save made while the rename's content was fetched", deps);
          return { status: "skipped" };
        }
        if (written === null) return { status: "unavailable" };
        if (written === "gone") return { status: "gone" };
        // **The source goes only if it holds what moved.** The path is often
        // reused before the echo arrives: rename `Untitled.md` to `Foo.md`,
        // press Ctrl+N, and a NEW `Untitled.md` sits unpushed for the settle
        // window. Trashing it by name would throw away a note the user just
        // made. Left in place with no ledger entry, it is exactly what it is —
        // a local file the vault has never seen — and the next derive pushes
        // it.
        const source = await vault.readBinary(event.from);
        if (source !== null && (await bytesHash(source)) === event.sha) {
          await vault.trash(event.from);
        }
        deps.onApplied?.({ path: event.from, hash: null });
        return { status: "applied", result: written, also: { path: event.from, hash: null } };
      }
      await vault.rename(event.from, event.path);
      // Reported immediately, both halves, for the reason `ApplyDeps.onApplied`
      // gives: a rename touches two paths on disk, so the watcher fires for two
      // paths, and until the ledger knows about both they look like local
      // changes to push back.
      deps.onApplied?.({ path: event.path, hash: event.sha });
      deps.onApplied?.({ path: event.from, hash: null });
      // TWO ledger entries, and both are needed. The old path no longer holds
      // anything, so leaving its hash behind would make the next derive see a
      // file that is gone as an unpushed local deletion. The new path's hash is
      // the same content under a different name, so it is carried across rather
      // than re-read.
      return {
        status: "applied",
        result: { path: event.path, hash: event.sha },
        also: { path: event.from, hash: null },
      };
    }
    default:
      console.warn(
        `Ctrl Notes: skipping an inbound event this build cannot apply (kind: "${event.kind}")`,
      );
      return { status: "skipped" };
  }
};

/** What one `flushEvents` pass actually accomplished — see `EventOutcome` for why this is
 * more than just `Applied[]`. */
export interface ReplayResult {
  readonly applied: Applied[];
  /**
   * The highest seq this device may ack, or `null` if not even the first event qualifies.
   *
   * Never past the first `"unavailable"` outcome (or a throw, treated the same way) in the
   * order events ARRIVED — even when a later event in the same batch happens to succeed.
   * `applyReplay` keeps trying every event regardless (this function's own header); this
   * field is the separate, independent answer to "how far may the cursor move", which
   * `pump.ts` cannot compute from a bare `Applied[]` at all.
   */
  readonly ackThrough: number | null;
  /**
   * Every seq this pass wanted to apply and could not, in arrival order.
   *
   * **`ackThrough` alone cannot survive a batch boundary.** It is computed
   * inside one call, so a later batch that applies cleanly reports its own
   * highest seq, and acking it claims every earlier event durable —
   * including one that failed. The vault resumes from the acked cursor and
   * never offers it again. `pump.ts` carries these across batches; here they
   * are only reported. ALL of them rather than the first, because a batch
   * can block on two events and a later redelivery can clear only one.
   *
   * `threw` is the subset that failed by throwing — a local filesystem
   * refusal rather than content that has not arrived. Only those count
   * toward giving up (`pump.ts`'s `MAX_LOCAL_FAILURES`).
   */
  readonly blocked: readonly number[];
  readonly threw: ReadonlyMap<number, string>;
}

/**
 * Apply a **replay** — events since our cursor. Deletes nothing this device was not
 * explicitly told to delete (rule 2's other half; see `applySnapshot` for the rule
 * itself). A path this device holds that no event here mentions is untouched, full stop —
 * it may simply be a note Obsidian Sync has not brought down yet.
 *
 * One unapplicable event must not strand the rest: `try`/`catch` per event, matching
 * glass-1's own reasoning for `applyChanges` — `applyEvent` returns `"skipped"` only for
 * what it can SEE (an unsafe path, an unknown kind); the filesystem refuses for reasons it
 * cannot (a folder gone mid-batch, a permission error), and those arrive as throws, handled
 * exactly like an `"unavailable"` outcome for the purpose of `ackThrough`.
 */
export const applyReplay = async (
  vault: VaultFiles,
  events: readonly DownEvent[],
  deps: ApplyDeps,
): Promise<ReplayResult> => {
  const applied: Applied[] = [];
  let ackThrough: number | null = null;
  let isBlocked = false;
  const blocked: number[] = [];
  const threw = new Map<number, string>();

  for (const event of events) {
    let outcome: EventOutcome;
    try {
      outcome = await applyEvent(vault, event, deps);
    } catch (e) {
      console.warn(`Ctrl Notes: could not apply an inbound ${event.kind} at ${event.path}`, e);
      isBlocked = true;
      blocked.push(event.seq);
      threw.set(event.seq, event.path);
      continue;
    }
    if (outcome.status === "applied") {
      applied.push(outcome.result);
      if (outcome.also !== undefined) applied.push(outcome.also);
    }
    if (outcome.status === "unavailable") {
      isBlocked = true;
      blocked.push(event.seq);
      continue;
    }
    // `"gone"` deliberately does NOT block. See `EventOutcome`: the content is
    // unrecoverable, so withholding the ack stalls this device forever rather
    // than buying a later retry that could succeed.
    if (!isBlocked) ackThrough = event.seq;
  }

  return { applied, ackThrough, blocked, threw };
};

/** What one `Down::Snapshot` actually accomplished. */
export interface SnapshotResult {
  readonly applied: Applied[];
  /**
   * Every entry the snapshot named was actually written or trashed — the ONLY condition
   * under which `pump.ts` may ack it (blocker fix, this file's `ReplayResult` carries the
   * matching reasoning for a replay). A snapshot claims to be the vault's whole current
   * state; acking one this device only partly matched would tell the vault this device is
   * caught up when it is not, and nothing rescans to notice later.
   */
  readonly complete: boolean;
  /**
   * Paths whose write or trash THREW — a local refusal (EACCES, a locked
   * file), not content that has not arrived. `pump.ts` counts these across
   * snapshots and, past `MAX_LOCAL_FAILURES`, names them in `giveUp` so one
   * path the filesystem will never accept cannot hold the device's cursor
   * for its whole life.
   */
  readonly threw: readonly string[];
}

/**
 * Apply a **snapshot** — current state, for a device far enough behind (design §8.4).
 *
 * **A snapshot is authoritative, not additive (rule 2).** Anything this device believes it
 * last synced (its ledger) and the snapshot never mentions was deleted while this device
 * was away — `planSnapshot` names those paths as `trash`, and trashing them here is the
 * whole reason that function and this one are split apart: one decides, one does.
 *
 * This is the one entry point in this file allowed to delete a path nothing here was told
 * to delete. `applyReplay` never does, and that asymmetry is deliberate — see its header.
 */
export const applySnapshot = async (
  vault: VaultFiles,
  ledger: Readonly<Record<string, string>>,
  files: readonly SnapshotEntry[],
  deps: ApplyDeps,
  options: DeriveOptions = {},
  giveUp: ReadonlySet<string> = new Set(),
): Promise<SnapshotResult> => {
  const { fetch, trash } = planSnapshot(ledger, files, options);
  // The same guard as a replay's: the snapshot is authoritative about the
  // VAULT, not about edits this device has not uploaded yet.
  const guarded: ApplyDeps = { ...deps, ledger: () => ledger };
  const threw: string[] = [];
  let complete = true;
  // A path that has failed here too many times running is reported and
  // passed over, so it stops holding `complete` false. Only ever for a
  // THROW — content that merely has not arrived keeps waiting.
  const refused = (path: string, e: unknown): void => {
    if (giveUp.has(path)) {
      console.warn(`Ctrl Notes: giving up on ${path}; this device keeps refusing it`, e);
      deps.onUnavailable?.(path, "refused_locally");
      return;
    }
    threw.push(path);
    complete = false;
  };
  const shaOf = new Map(files.map((f) => [f.path, f.sha]));
  const applied: Applied[] = [];

  for (const path of trash) {
    try {
      // **Already gone is done, not failed** — the same rule as the replay's
      // `delete` case, and here it is self-perpetuating without it: `trash`
      // names ledger paths the snapshot omits, so a file deleted on another
      // device AND already gone from this disk throws `ENOENT`, the snapshot
      // is never acked, its ledger entry is never cleared, and the next
      // snapshot names the same path again.
      if (await vault.exists(path, false)) {
        if ((await heldLocally(vault, path, guarded)).held) {
          // Gone from the vault, edited here: the edit wins (design §4) and
          // uploads as a new file.
          keep(path, "trashing it for a snapshot that no longer names it", guarded);
        } else {
          await vault.trash(path);
        }
      }
      applied.push({ path, hash: null });
    } catch (e) {
      console.warn(`Ctrl Notes: could not trash ${path} while applying a snapshot`, e);
      refused(path, e);
    }
  }

  for (const path of fetch) {
    const sha = shaOf.get(path);
    if (sha === undefined) continue; // planSnapshot only ever names a path `files` has.
    try {
      const local = await heldLocally(vault, path, guarded);
      if (local.hash === sha) {
        // Already holds exactly this version — only the ledger was behind.
        const same = { path, hash: sha };
        deps.onApplied?.(same);
        applied.push(same);
        continue;
      }
      if (local.held) {
        // Its ledger entry stays the base it was edited from, so the upload
        // merges against exactly that — never "incomplete": waiting cannot
        // change it, and the upload is what resolves it.
        keep(path, "overwriting it with a snapshot's version", guarded);
        continue;
      }
      const result = await fetchAndWrite(vault, path, sha, deps, local.hash);
      if (result === "moved-on") {
        keep(path, "overwriting a save made while the snapshot's version was fetched", guarded);
        continue;
      }
      if (result === "gone") {
        // Permanently absent. `complete` means "this device matches the
        // snapshot as well as it ever can", and a blob the vault says is gone
        // is matched: withholding the ack here is what turns one lost file
        // into a device that re-snapshots forever. `fetchAndWrite` has already
        // told `onUnavailable` which path it was (O3).
        console.warn(`Ctrl Notes: the vault will never supply ${path}; continuing without it`);
      } else if (result !== null) applied.push(result);
      else complete = false; // Fetched nothing — this device does not match the snapshot yet.
    } catch (e) {
      console.warn(`Ctrl Notes: could not apply the snapshot's content for ${path}`, e);
      refused(path, e);
    }
  }

  return { applied, complete, threw };
};
