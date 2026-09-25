import type { SnapshotEntry } from "../wire.ts";
import { type DeriveOptions, syncablePath } from "./derive.ts";

/**
 * What a snapshot means for this device — **ours, not glass-1's four-way `Split`.**
 *
 * Glass-1's `ManifestResponse` was the SERVER comparing a manifest the device had just
 * uploaded against its own live set, and handing back `pull`/`push`/`deleted`/`differ`
 * already computed. Our vault does no such comparison: `Up::Snapshot` carries no payload
 * at all, and `Down::Snapshot` answers with nothing but its own current `(path, sha)`
 * pairs (design §8.4). So the diffing this function does — comparing that snapshot
 * against what THIS device believes it last synced — has no server-side counterpart to
 * port; it is genuinely new, on the client, because nobody else can do it for us.
 *
 * There is no `push` or `differ` here, and that is not an oversight: our snapshot carries
 * no information at all about what a device holds that the vault does not, so this
 * function cannot compute one. A path this device edited while it was disconnected keeps
 * being caught the ordinary way — Obsidian's own file-watcher marks it dirty, and the
 * settle → derive pipeline (unaffected by any of this) pushes it on its own schedule.
 * `manifest-scan.ts` exists for a device that wants to catch edits the watcher missed
 * entirely (a relink, or a change made while the plugin was not running at all), but
 * wiring that in is a later task's job, not this one's.
 */
export interface SnapshotSplit {
  /** Paths whose content we must fetch — new to us, or changed since we last synced. */
  readonly fetch: readonly string[];
  /**
   * Paths this device believes it holds that the snapshot never mentions at all.
   *
   * **Rule 2, and the reason this function exists.** A snapshot is authoritative: anything
   * held locally and absent from it was deleted while this device was away (design §8.4).
   * `apply.ts`'s `applySnapshot` is what actually removes them — this function only names
   * them, the same division of labour glass-1's `planReconcile` kept between deciding and
   * doing.
   */
  readonly trash: readonly string[];
}

/**
 * Diff a snapshot against this device's ledger.
 *
 * **`hashes` is the ledger (`SyncState.hashes`), never a live disk scan.** That is what
 * makes `trash`'s premise sound: a path present in the ledger is one this device once
 * held a `base` for and believes is still live, so its absence from `files` really does
 * mean "gone while we were away" rather than "never uploaded in the first place". A path
 * on disk this device has never synced is not in the ledger, so it never appears in
 * `trash` — it is a local creation, not a deletion, and `deriveChanges` finds it in its
 * own time.
 *
 * **`fetch` is keyed off the ledger too, not off what actually happens to be on disk
 * right now.** A path whose ledger hash already matches the snapshot's is in step and
 * costs nothing; anything else — new to the ledger, or changed since — needs its content,
 * which `apply.ts` retrieves by `sha` the same way an ordinary replay event does.
 */
export const planSnapshot = (
  hashes: Readonly<Record<string, string>>,
  files: readonly SnapshotEntry[],
  options: DeriveOptions = {},
): SnapshotSplit => {
  const attachments = options.attachments ?? true;
  const syncable = (path: string): boolean => syncablePath(path, attachments);

  const remote = new Map(files.filter((f) => syncable(f.path)).map((f) => [f.path, f.sha]));

  const fetch: string[] = [];
  for (const [path, sha] of remote) {
    if (hashes[path] !== sha) fetch.push(path);
  }

  const trash = Object.keys(hashes).filter((path) => syncable(path) && !remote.has(path));

  return { fetch, trash };
};
