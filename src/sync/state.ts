import type { App } from "obsidian";
import { isWellFormedHash } from "./hash.ts";

/**
 * What this device has synced, persisted where only this device can see it.
 *
 * **Not `saveData`.** That writes `.obsidian/plugins/…/data.json` *inside the vault*, which
 * Obsidian Sync then replicates to the user's other devices (design §4.1). A shared cursor is
 * two devices overwriting each other's position in one log; a shared hash map is each
 * device claiming the other's `base`. `saveLocalStorage` is per-device and Obsidian already
 * scopes it per vault.
 *
 * **`hashes` is not a cache and cannot be rebuilt by scanning.** `base` must be the hash of
 * bytes the SERVER once held — `decide` resolves those to `ancestor` and merges against
 * them. The hash of whatever is on disk right now is bytes the server never saw, which
 * resolves to `unknown_base` and rejects. Losing this map means every file edited while the
 * plugin was closed can no longer be pushed cleanly.
 */
export interface SyncState {
  /** The highest server change this device has applied. */
  readonly cursor: number;
  /** Path → the hash this device last synced at it, which is its `base` on the wire. */
  readonly hashes: Readonly<Record<string, string>>;
}

/**
 * The slice of `App` this needs.
 *
 * Narrow on purpose: a test fakes two methods rather than constructing an `App`, and the
 * type still comes from the real `obsidian` package, so a signature drift is a typecheck
 * failure rather than a fake that quietly disagrees.
 */
export type LocalStore = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

const KEY = "ctrlrouter:sync-state";

export const EMPTY_STATE: SyncState = { cursor: 0, hashes: {} };

/**
 * `isSafeInteger`, not `isInteger`: `Number.MAX_VALUE` and `2 ** 53 + 2` are both integers
 * by the looser test, and either one read back as a cursor is exactly the permanent skip
 * `loadSyncState` exists to prevent. `unified.ts` next door already draws the line here.
 */
const isCursor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isHashes = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((h) => typeof h === "string" && isWellFormedHash(h));

/**
 * Anything that is not exactly what we wrote reads as a device that has never synced.
 *
 * Deliberately not a repair: a partly-trusted cursor is the one failure that loses data
 * silently, because a cursor too high skips every change below it forever. Starting over is
 * slow and correct, so it wins.
 */
export const loadSyncState = (store: LocalStore, vaultId: string): SyncState => {
  const raw: unknown = store.loadLocalStorage(KEY);
  if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
  const {
    cursor,
    hashes,
    vaultId: stamp,
  } = raw as { cursor?: unknown; hashes?: unknown; vaultId?: unknown };
  if (!isCursor(cursor) || !isHashes(hashes)) return EMPTY_STATE;
  // **The stamp, under the same posture as everything above it.** A record describing a
  // DIFFERENT vault reads as a device that has never synced.
  //
  // Unlinking and relinking onto another vault is a supported flow, and nothing cleared
  // this record across it — so vault A's hash map answered for vault B. That matters
  // because `planReconcile`'s trash guard is the only thing between the server's tombstone
  // list and the user's files, and its whole premise is "we once held this path". A
  // foreign hash map satisfies that premise for paths we never held, and the reconcile
  // moves live local files to `.trash`.
  //
  // Not detectable any other way: `cursor_ahead` catches only the case where the stale
  // cursor happens to EXCEED the new vault's head. Below it, a stale cursor is
  // arithmetically indistinguishable from an honest one.
  if (stamp !== vaultId) return EMPTY_STATE;
  // **Not folded to NFC on read, and that is deliberate.** Every writer of this map keys
  // on a path the SERVER returned — `result.path`, `result.copy_path`, `omission.path`,
  // `file.path`, `change.path` — and the server only ever returns NFC. No build has
  // written a disk spelling here, so a fold has nothing to fold; it was a migration for a
  // record that cannot exist. It is not free either: `applyReconcile` calls this once per
  // manifest chunk, so a 50k-key map paid tens of milliseconds of main-thread work per
  // chunk to rebuild itself unchanged.
  return { cursor, hashes };
};

export const saveSyncState = (store: LocalStore, vaultId: string, state: SyncState): void => {
  store.saveLocalStorage(KEY, { vaultId, cursor: state.cursor, hashes: state.hashes });
};

/**
 * Claim an unstamped record for the vault this device is linked to.
 *
 * Written by a version that predates the stamp, so it describes whatever vault the device
 * was linked to then — which, for every device that has not relinked, is this one.
 * Discarding it instead would make every existing install re-upload its whole vault on
 * upgrade, to fix a hazard those installs are not in.
 *
 * Idempotent by construction rather than by a flag: afterwards the record IS stamped, so
 * the `stamp === undefined` guard never fires again — including for a different vault id.
 */
export const adoptUnstampedState = (store: LocalStore, vaultId: string): void => {
  const raw: unknown = store.loadLocalStorage(KEY);
  if (typeof raw !== "object" || raw === null) return;
  const {
    cursor,
    hashes,
    vaultId: stamp,
  } = raw as { cursor?: unknown; hashes?: unknown; vaultId?: unknown };
  if (stamp !== undefined) return;
  if (!isCursor(cursor) || !isHashes(hashes)) return;
  saveSyncState(store, vaultId, { cursor, hashes });
};
