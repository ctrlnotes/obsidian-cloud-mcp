import type { SnapshotEntry } from "../wire.ts";
import { syncablePath } from "./derive.ts";
import { bytesHash } from "./hash.ts";
import { comparePaths } from "./path-order.ts";
import { classifyPath, decodesAsText } from "./safe-path.ts";

/** The vault, as a manifest scan needs it. */
export interface ScannableVault {
  /**
   * Every file path in the vault, as the WIRE spells them — NFC, one entry per path.
   * Order irrelevant: this sorts.
   */
  list(): Promise<readonly string[]>;
  /** Every path's content, text or not — see `ReadableFiles.readBinary` for why there is
   * no `read` beside this one any more. */
  readBinary(path: string): Promise<Uint8Array | null>;
  /** Metadata only — the whole reason an oversized attachment is never read. */
  stat(path: string): Promise<{ size: number } | null>;
}

export interface ScanOptions {
  /** Whether this device holds attachments at all (mobile does not). */
  readonly attachments: boolean;
}

/**
 * This device's whole local manifest — every syncable path and the hash of its bytes.
 *
 * **Not chunked, unlike glass-1's `scanManifest`.** Theirs paginated an OUTBOUND upload:
 * the device submitted its manifest to the server over `ManifestRequest`, capped by
 * `MAX_MANIFEST_ENTRIES`/`MAX_MANIFEST_BYTES` because that request rode an ordinary HTTP
 * body. Our vault never receives a manifest at all — `Up::Snapshot` is a bare request with
 * no payload, and `Down::Snapshot` answers with the vault's OWN live set (design §8.4). So
 * there is nothing here to paginate: this is a purely local computation, compared against
 * a snapshot entirely on this device, and its result never crosses the wire.
 *
 * **Sorted with the vendored `comparePaths`, never JavaScript `<`.** Not load-bearing the
 * way it was for glass-1's chunk boundaries — nothing here chunks — but a deterministic
 * order is worth keeping for a function whose whole job is a byte-for-byte comparison, and
 * an emoji filename sorting differently than expected has already shipped once as a bug.
 *
 * **Reports only what the write floor would accept.** A path we would refuse inbound is
 * one we must not report, or a reconcile against it offers us changes for it forever.
 */
const hashOf = async (vault: ScannableVault, path: string): Promise<string | null> => {
  // **`stat` before `readBinary`, for a path that is NOT text.** A device that discovers an
  // attachment is too large to hold by reading it has already buffered the whole file.
  // Unlike derive.ts there is no size cap to enforce here — a scan reports what IS on
  // disk, it does not decide what may be SENT — so `stat` failing (gone mid-scan) is the
  // only thing this checks for; it never rejects for size. A text path skips it: there is
  // no size question to answer first, and the read below settles existence anyway.
  if (classifyPath(path) !== "text") {
    if ((await vault.stat(path)) === null) return null;
  }
  const bytes = await vault.readBinary(path);
  if (bytes === null) return null;
  // **The vault's own question, and the vault now asks it by PATH.**
  // `ApplyBatchCommand` requires text where `projections::projects_content` says the
  // content is projected — every note, every `.base` — and stores anything else as an
  // attachment. So a NOTE whose bytes do not decode is one this device cannot sync, and
  // claiming it starts the loop `safe-path.ts`'s `decodesAsText` describes: reported in
  // the manifest, made dirty, pushed, refused with no `current_sha`, and reported again on
  // the next reconnect with nothing changed on disk to end it.
  //
  // **This gate was unconditional, and it had to stop being so the moment attachments
  // started syncing.** It was written that way deliberately, mirroring an `apply_upload`
  // that ran `String::from_utf8` over every upload and had no blob branch — correct then,
  // and latent because `main.ts` held attachments back on every device. With
  // `edit::Op::PutBytes` and that getter true, leaving it unconditional means `derive.ts`
  // SENDS an image while this refuses to claim one: the manifest never names it, so every
  // reconnect marks it dirty and re-reads and re-hashes it to discover it was already in
  // step. The two halves must ask the same question, and `derive.ts`'s is this one.
  return classifyPath(path) !== "text" || decodesAsText(bytes) ? await bytesHash(bytes) : null;
};

export const scanManifest = async (
  vault: ScannableVault,
  options: ScanOptions,
): Promise<SnapshotEntry[]> => {
  const paths = (await vault.list())
    .filter((path) => syncablePath(path, options.attachments))
    .sort(comparePaths);

  const entries: SnapshotEntry[] = [];
  for (const path of paths) {
    // **A per-path filesystem error must not abandon the whole scan.** `stat`/`readBinary`
    // return `null` for "gone before we looked", which is handled below — but they REJECT
    // for the check-then-use race (`vaultFiles`'s `readBinary` tests `exists` and then
    // reads, and ENOENT can land between the two), for EACCES, and for EIO. That rejection
    // used to escape `scanManifest` into `reconcileManifest`, which is awaited BEFORE all
    // three of its passes, so one unreadable file anywhere in the vault cancelled every
    // dirty mark, every warning and the whole ledger-deletion pass — identically on every
    // reconnect, for as long as that one file stayed unreadable. `derive.ts` guards its own
    // per-path read exactly this way and `apply.ts`'s `applyReplay` guards per event; this
    // is the third reader, and it is the same guard, not a third shape.
    //
    // Skipped, not reported: a path this could not read is "not claimed", which is what the
    // `null` below already means, and `main.ts`'s `reconcileManifest` turns that into a
    // dirty mark rather than a deletion.
    let sha: string | null;
    try {
      sha = await hashOf(vault, path);
    } catch (e) {
      console.warn(`Ctrl Notes: could not read ${path} while scanning this vault`, e);
      continue;
    }
    // Listed, then gone — or unreadable, or not text after all. The vault is changing
    // underneath us, which is §6a's premise. Reporting a vanished file with the hash of
    // "" would read as a real divergence and invite an inbound write over the top of one
    // that may still exist.
    //
    // **A path missing from these entries therefore means "not claimed", never "not on
    // disk"**, which is why `main.ts`'s `reconcileManifest` infers a deletion from the
    // vault LISTING and not from what this returned. `reconcileManifest` did read it
    // out of these entries, and a file that merely could not be read was pushed as a
    // delete — destroying, on every other device, a file sitting right there on this one.
    if (sha === null) continue;
    entries.push({ path, sha });
  }
  return entries;
};
