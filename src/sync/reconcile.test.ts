import { describe, expect, it } from "vitest";
import type { SnapshotEntry } from "../wire.ts";
import { planSnapshot } from "./reconcile.ts";

/**
 * `planSnapshot` names paths. It does not read them, hash them, or touch the filesystem —
 * `apply.ts`'s `applySnapshot` is what actually fetches and trashes.
 */
const H = (n: string) => n.repeat(64);

describe("planSnapshot", () => {
  it("does nothing when the ledger and the snapshot already agree", () => {
    const files: SnapshotEntry[] = [{ path: "a.md", sha: H("a") }];
    expect(planSnapshot({ "a.md": H("a") }, files)).toEqual({ fetch: [], trash: [] });
  });

  it("fetches a path new to the ledger", () => {
    const files: SnapshotEntry[] = [{ path: "theirs.md", sha: H("b") }];
    expect(planSnapshot({}, files).fetch).toEqual(["theirs.md"]);
  });

  it("fetches a path whose remote sha has moved on since we last synced", () => {
    const files: SnapshotEntry[] = [{ path: "a.md", sha: H("new") }];
    expect(planSnapshot({ "a.md": H("old") }, files).fetch).toEqual(["a.md"]);
  });

  it("trashes what the ledger holds and the snapshot does not mention at all", () => {
    // Rule 2: a snapshot is authoritative. A path we believe we last synced, absent from
    // the vault's current live set, was deleted while this device was away.
    const split = planSnapshot({ "old.md": H("a") }, []);
    expect(split.trash).toEqual(["old.md"]);
    expect(split.fetch).toEqual([]);
  });

  it("does not trash a path we have never synced", () => {
    // A path never in the ledger was never told to the vault in the first place — it is
    // a local creation, not something deleted elsewhere. Absence from `trash` here is
    // deliberate: `deriveChanges` finds it on its own schedule.
    expect(planSnapshot({}, []).trash).toEqual([]);
  });

  it("never derives a deletion from a snapshot naming nothing at all", () => {
    expect(planSnapshot({ "a.md": H("a") }, [{ path: "a.md", sha: H("a") }])).toEqual({
      fetch: [],
      trash: [],
    });
  });

  it("refuses a snapshot entry the write floor rejects", () => {
    const files: SnapshotEntry[] = [{ path: ".obsidian/app.json", sha: H("a") }];
    expect(planSnapshot({}, files)).toEqual({ fetch: [], trash: [] });
  });

  it("refuses to trash a ledger path the write floor would reject", () => {
    // Defence in depth: nothing should ever put a refused path in the ledger, but this
    // function does not trust that either.
    expect(planSnapshot({ "hook.sh": H("a") }, [])).toEqual({ fetch: [], trash: [] });
  });

  it("drops an attachment on a device that carries none, on both lists", () => {
    const files: SnapshotEntry[] = [
      { path: "a.png", sha: H("a") }, // new, would otherwise be a fetch
    ];
    const off = planSnapshot({ "b.png": H("b") }, files, { attachments: false });
    expect(off).toEqual({ fetch: [], trash: [] });

    // And the same device with attachments on sees both.
    const on = planSnapshot({ "b.png": H("b") }, files, { attachments: true });
    expect(on).toEqual({ fetch: ["a.png"], trash: ["b.png"] });
  });

  it("handles several paths independently", () => {
    const files: SnapshotEntry[] = [
      { path: "unchanged.md", sha: H("u") },
      { path: "moved-on.md", sha: H("new") },
      { path: "new-to-us.md", sha: H("n") },
    ];
    const hashes = {
      "unchanged.md": H("u"),
      "moved-on.md": H("old"),
      "gone.md": H("g"),
    };
    expect(planSnapshot(hashes, files)).toEqual({
      fetch: ["moved-on.md", "new-to-us.md"],
      trash: ["gone.md"],
    });
  });
});
