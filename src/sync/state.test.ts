import { describe, expect, it, vi } from "vitest";
import {
  adoptUnstampedState,
  EMPTY_STATE,
  type LocalStore,
  loadSyncState,
  saveSyncState,
} from "./state.ts";

/** The vault a stored record describes. Every case here is about one vault. */
const VAULT = "vlt_1";

/**
 * A fake of `App`'s two localStorage methods. Obsidian scopes them per vault; this fake is
 * one vault, and a second instance is a second vault — which is what the isolation case
 * below actually exercises.
 */
const fakeStore = (): LocalStore & { readonly raw: Map<string, unknown> } => {
  const raw = new Map<string, unknown>();
  return {
    raw,
    loadLocalStorage: (key: string) => raw.get(key) ?? null,
    saveLocalStorage: (key: string, data: unknown) => {
      if (data === null) raw.delete(key);
      else raw.set(key, data);
    },
  };
};

describe("the sync state store", () => {
  it("starts empty on a device that has never synced", () => {
    expect(loadSyncState(fakeStore(), VAULT)).toEqual(EMPTY_STATE);
  });

  it("round-trips a cursor and its hashes", () => {
    const store = fakeStore();
    const state = { cursor: 4712, hashes: { "Notes/a.md": "a".repeat(64) } };
    saveSyncState(store, VAULT, state);
    expect(loadSyncState(store, VAULT)).toEqual(state);
  });

  it("keeps two vaults separate", () => {
    // The whole reason this is not `saveData`: data.json lives inside the vault and
    // Obsidian Sync replicates it, so two devices would share one cursor and clobber each
    // other's hash map. localStorage is per-device and Obsidian scopes it per vault.
    const one = fakeStore();
    const two = fakeStore();
    saveSyncState(one, VAULT, { cursor: 1, hashes: { "a.md": "a".repeat(64) } });
    expect(loadSyncState(two, VAULT)).toEqual(EMPTY_STATE);
  });

  it("falls back to empty when the stored value is not the shape we wrote", () => {
    // localStorage is shared mutable ground and survives downgrades. A device that reads
    // a malformed cursor and trusts it would skip every change below it, permanently —
    // resyncing from scratch is the recoverable failure, so it is the one we choose.
    const store = fakeStore();
    for (const junk of [
      "not an object",
      42,
      null,
      {},
      { cursor: "4712", hashes: {} },
      { cursor: 4712 },
      { cursor: -1, hashes: {} },
      { cursor: 1.5, hashes: {} },
      // regression: `Number.isInteger` accepts both of these, so a cursor past the safe
      // range read back as valid — the permanent-skip failure this whole case exists to
      // prevent, arriving through the guard rather than around it.
      { cursor: 2 ** 53, hashes: {} },
      { cursor: Number.MAX_VALUE, hashes: {} },
      { cursor: 4712, hashes: "nope" },
      { cursor: 4712, hashes: { "a.md": 7 } },
      { cursor: 4712, hashes: { "a.md": "too short" } },
    ]) {
      store.raw.set("ctrlrouter:sync-state", junk);
      expect(loadSyncState(store, VAULT), JSON.stringify(junk)).toEqual(EMPTY_STATE);
    }
  });

  it("stores a plain object, so a future reader is not parsing our types", () => {
    const store = fakeStore();
    saveSyncState(store, VAULT, { cursor: 9, hashes: { "a.md": "b".repeat(64) } });
    expect(JSON.parse(JSON.stringify(store.raw.get("ctrlrouter:sync-state")))).toEqual({
      vaultId: VAULT,
      cursor: 9,
      hashes: { "a.md": "b".repeat(64) },
    });
  });

  // regression: a relink onto another vault let vault A's hash map answer for vault B, and
  // `planReconcile` trashed local files on B's tombstones. The trash guard's whole premise
  // is "we once held this path", and a foreign hash map satisfies it for paths we never
  // held. `cursor_ahead` catches only the case where the stale cursor EXCEEDS the new
  // vault's head; below it there is no arithmetic that separates stale from honest.
  it("does not answer for a vault it does not describe", () => {
    const store = fakeStore();
    const saved = { cursor: 5, hashes: { "note.md": "a".repeat(64) } };
    saveSyncState(store, "vlt_A", saved);

    expect(loadSyncState(store, "vlt_B")).toEqual(EMPTY_STATE);
    expect(loadSyncState(store, "vlt_A")).toEqual(saved);
  });

  describe("adopting a record written before the stamp existed", () => {
    const unstamped = { cursor: 5, hashes: { "note.md": "a".repeat(64) } };

    it("claims it for the vault this device is linked to", () => {
      // Discarding it instead would make every existing install re-upload its whole vault
      // on upgrade, to fix a hazard those installs are not in.
      const store = fakeStore();
      store.raw.set("ctrlrouter:sync-state", { ...unstamped });

      adoptUnstampedState(store, "vlt_A");

      expect(loadSyncState(store, "vlt_A")).toEqual(unstamped);
      expect(loadSyncState(store, "vlt_B")).toEqual(EMPTY_STATE);
    });

    it("leaves a record that is already stamped alone", () => {
      // Idempotent by construction rather than by a flag: after the first adoption the
      // record IS stamped, so the guard never fires again — including for another vault.
      const store = fakeStore();
      saveSyncState(store, "vlt_A", unstamped);

      adoptUnstampedState(store, "vlt_B");

      expect(loadSyncState(store, "vlt_A")).toEqual(unstamped);
      expect(loadSyncState(store, "vlt_B")).toEqual(EMPTY_STATE);
    });

    it("does not adopt a record that fails the ordinary guards", () => {
      const store = fakeStore();
      store.raw.set("ctrlrouter:sync-state", { cursor: -1, hashes: {} });

      adoptUnstampedState(store, "vlt_A");

      expect(loadSyncState(store, "vlt_A")).toEqual(EMPTY_STATE);
    });
  });

  it("returns the stored hashes verbatim, non-NFC key and all", () => {
    // **The decision, pinned so it is re-argued rather than re-added.** An earlier version
    // folded keys to NFC on read, as a migration for records written before the plugin
    // normalised. There are none: every writer of this map keys on a path the SERVER
    // returned, and the server only ever returns NFC. The fold folded nothing, and it was
    // not free — `applyReconcile` calls `loadSyncState` once per manifest chunk, so a
    // large map paid to rebuild itself unchanged on every one.
    //
    // If a genuine non-NFC key ever appears here, this test is where to start.
    const nfd = "cafe\u0301.md";
    const store = fakeStore();
    store.raw.set("ctrlrouter:sync-state", {
      vaultId: VAULT,
      cursor: 4,
      hashes: { [nfd]: "a".repeat(64) },
    });
    expect(loadSyncState(store, VAULT).hashes).toEqual({ [nfd]: "a".repeat(64) });
  });
});

/**
 * The cursor's own tripwire, in the shape of Task 3's key one (`device.test.ts`'s "the
 * private key never passes through saveData"). Plugin design §4.1 makes the point about
 * the private key, but the reasoning is not special to keys: `saveData` writes
 * `.obsidian/plugins/<id>/data.json` INSIDE the vault, so anything written through it is
 * replicated by Obsidian Sync to every other device. glass-1 found this for the cursor
 * FIRST and wrote why in this file's own header comment — a shared cursor is two devices
 * overwriting each other's position in one log. The key moved to `secretStorage`
 * (`device.ts`); the cursor already used `saveLocalStorage` and has no reason to move
 * anywhere near `secretStorage` either, which is for secrets, not per-device sync
 * position. This pins that it stays on `saveLocalStorage`.
 */
describe("the cursor never reaches saveData", () => {
  it("does not appear in anything saveData wrote, even offered on the same object", () => {
    const raw = new Map<string, unknown>();
    const vaultFiles = new Map<string, string>();
    // One object offering both surfaces, the way a real `App` does — so a regression that
    // reached for the wrong one would still have it in hand.
    const app: LocalStore & { saveData(data: unknown): Promise<void> } = {
      loadLocalStorage: (key: string) => raw.get(key) ?? null,
      saveLocalStorage: (key: string, data: unknown) => {
        if (data === null) raw.delete(key);
        else raw.set(key, data);
      },
      saveData: vi.fn(async (d: unknown) => {
        vaultFiles.set(".obsidian/plugins/ctrl-notes-cloud-mcp/data.json", JSON.stringify(d));
      }),
    };

    saveSyncState(app, VAULT, { cursor: 4821, hashes: { "Notes/a.md": "a".repeat(64) } });

    expect(app.saveData).not.toHaveBeenCalled();
    for (const contents of vaultFiles.values()) {
      expect(contents).not.toContain("4821");
    }
  });
});
