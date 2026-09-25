import { describe, expect, it } from "vitest";
import type { DownEvent, SnapshotEntry } from "../wire.ts";
import {
  type ApplyDeps,
  applyReplay,
  applySnapshot,
  pullIfUnchanged,
  type VaultFiles,
} from "./apply.ts";
import { bytesHash, contentHash } from "./hash.ts";
import { planSnapshot } from "./reconcile.ts";

/**
 * A fake disk holding **bytes**, for text as much as for an attachment.
 *
 * It held two maps — a `Map<string, string>` for text and a `Map<string, Uint8Array>` for
 * attachments — which is the shape `apply.ts` itself had before the write side became
 * byte-exact, and it is a shape in which the defect that change fixes is not expressible:
 * a double that stores a decoded string cannot tell "wrote the bytes" from "wrote a
 * re-encoding of a decoding of the bytes", and those differ by a BOM. One map, and
 * {@link text} for the cases that only care which words landed.
 */
const fakeVault = (
  initial: Record<string, string> = {},
): VaultFiles & {
  readonly files: Map<string, Uint8Array>;
  text(path: string): string | undefined;
} => {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, body]) => [path, utf8(body)]),
  );
  return {
    files,
    text: (path) => {
      const held = files.get(path);
      return held === undefined ? undefined : new TextDecoder().decode(held);
    },
    readBinary: (path) => Promise.resolve(files.get(path) ?? null),
    writeBinary: (path, bytes) => {
      files.set(path, bytes);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    // **Both throw where Obsidian's adapter throws.** The forgiving versions
    // these replace made the 2026-09-22 defect inexpressible: an echoed
    // rename or delete silently did nothing here and raised on a real device,
    // where the raise withheld the ack and stalled the cursor.
    trash: (path) => {
      if (!files.has(path)) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, rename '${path}'`));
      }
      files.delete(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      if (!files.has(from)) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, rename '${from}'`));
      }
      if (files.has(to)) return Promise.reject(new Error("Destination file already exists!"));
      // Not `if (body !== undefined)`: after the guard above it cannot be,
      // and a double that deleted the source, created nothing and reported
      // success would be the same kind of lie these throws removed.
      const body = files.get(from) as Uint8Array;
      files.delete(from);
      files.set(to, body);
      return Promise.resolve();
    },
  };
};

/** A source of bytes keyed by sha, so a test states only what content exists. */
const fetcherFor = (content: Record<string, Uint8Array>): ApplyDeps => ({
  fetchBytes: (sha) => {
    const value = content[sha];
    return value
      ? Promise.resolve({ ok: true as const, value })
      : Promise.resolve({ ok: false as const, code: "not_found" });
  },
});

const utf8 = (s: string) => new TextEncoder().encode(s);

const putEvent = (over: Partial<DownEvent> & { path: string; sha: string }): DownEvent => ({
  type: "event",
  seq: 1,
  kind: "put",
  from: null,
  at_ms: 0,
  ...over,
});

describe("applyReplay", () => {
  it("applies a put by fetching its content and writing it", async () => {
    const vault = fakeVault();
    const bytes = utf8("hello\n");
    const sha = await contentHash("hello\n");
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha })],
      fetcherFor({ [sha]: bytes }),
    );
    expect(vault.text("a.md")).toBe("hello\n");
    // The hash WE computed from the bytes we wrote, never the sha the frame claimed.
    expect(applied).toEqual([{ path: "a.md", hash: await contentHash("hello\n") }]);
  });

  /**
   * `apply.ts`'s doc comment states it in bold: what comes back is the hash of the bytes
   * actually written, NEVER the `sha` a frame claimed.
   *
   * **The two now agree by construction, and that is the point.** This used to be shown by
   * handing back bytes that did not hash to the sha the event named — the only way to make
   * `hash: sha` and `hash: contentHash(bytes)` distinguishable for text. Such a fetch is
   * refused outright now (see "bytes that do not match the sha they were fetched for"):
   * content is addressed by its hash, so accepting bytes from the wrong address writes
   * corruption to disk and then pushes it back up as authoritative.
   *
   * So the rule is enforced more strongly than it was, and the observable claim changes
   * with it: the recorded hash is DERIVED from what was written, and equals the sha
   * precisely because anything else was rejected before the write.
   */
  it("records a hash derived from what it wrote, which now always matches the sha", async () => {
    const vault = fakeVault();
    const body = "actually these bytes\n";
    const sha = await contentHash(body);
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha })],
      fetcherFor({ [sha]: utf8(body) }),
    );
    expect(vault.text("a.md")).toBe(body);
    expect(applied).toEqual([{ path: "a.md", hash: await contentHash(body) }]);
    // Derived from the file, not copied from the frame — the same value, reached the
    // honest way. Hashed from the BYTES on disk rather than from a decode of them, which
    // is what `apply.ts` records and the only form in which the claim is byte-exact.
    expect(applied[0]?.hash).toBe(await bytesHash(vault.files.get("a.md") ?? new Uint8Array()));
  });

  it("applies a put attachment by fetching its bytes and writing binary", async () => {
    const vault = fakeVault();
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = await bytesHash(bytes);
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "img.png", sha })],
      fetcherFor({ [sha]: bytes }),
    );
    expect(vault.files.get("img.png")).toEqual(bytes);
    expect(applied).toEqual([{ path: "img.png", hash: sha }]);
  });

  /**
   * The point of design §5's "a conflict file arrives as an ordinary put and needs no
   * special case": there is nothing here that inspects a path for "(conflict)" or any
   * other marker. The vault names a normal path and a normal sha, and this applies it the
   * identical way it applies anything else.
   */
  it("applies a conflict copy exactly like any other put, with no special case", async () => {
    const vault = fakeVault();
    const bytes = utf8("mine, kept as a copy\n");
    const sha = await contentHash("mine, kept as a copy\n");
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "note (conflicted copy).md", sha })],
      fetcherFor({ [sha]: bytes }),
    );
    expect(vault.text("note (conflicted copy).md")).toBe("mine, kept as a copy\n");
    expect(applied).toEqual([{ path: "note (conflicted copy).md", hash: sha }]);
  });

  it("deletes, and reports the path with no hash", async () => {
    const vault = fakeVault({ "a.md": "bye\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 1, kind: "delete", path: "a.md", sha: null, from: null, at_ms: 0 }],
      fetcherFor({}),
    );
    expect(vault.files.has("a.md")).toBe(false);
    expect(applied).toEqual([{ path: "a.md", hash: null }]);
    expect(ackThrough).toBe(1);
  });

  /**
   * **Blocker fix.** Before this, `pump.ts` acked the batch's own highest seq regardless of
   * what actually applied — so an event this build cannot fetch (every `put` today, until
   * write-surface design §8.1's fetch frame exists) was acked past anyway, and the resume
   * point it named was gone for good. `ackThrough` is the mechanism that makes that
   * impossible: `null` here means not even the first event in this batch may be acked.
   */
  it("writes nothing when the fetch fails, and reports nothing ackable", async () => {
    const vault = fakeVault();
    const { applied, ackThrough } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha: "a".repeat(64), seq: 41 })],
      fetcherFor({}),
    );
    expect(vault.files.has("a.md")).toBe(false);
    expect(applied).toEqual([]);
    expect(ackThrough).toBeNull();
  });

  /**
   * The exact shape of the blocker probe: a batch of two events where the first cannot be
   * fetched and the second can. The second is still applied (`applyReplay` never strands
   * later events — see "keeps going after one event fails" below), but `ackThrough` must
   * stop BEFORE the failure, not advance to the later event's own higher seq — acking past
   * an event this build never actually wrote is the bug, however far a later one got.
   */
  it("does not ack past an event it could not fetch, even when a later one succeeds", async () => {
    const vault = fakeVault();
    const good = await contentHash("yes\n");
    const { applied, ackThrough } = await applyReplay(
      vault,
      [
        putEvent({ path: "bad.md", sha: "not-fetchable", seq: 41 }),
        putEvent({ path: "good.md", sha: good, seq: 42 }),
      ],
      fetcherFor({ [good]: utf8("yes\n") }),
    );
    expect(applied.map((a) => a.path)).toEqual(["good.md"]); // still written — see above
    expect(ackThrough).toBeNull(); // but NOT ackable: seq 41 was never actually applied
  });

  it("acks through the last event a fetch failure did not block", async () => {
    const shaA = await contentHash("a\n");
    const vault = fakeVault();
    const { ackThrough: throughFirst } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha: shaA, seq: 5 })],
      fetcherFor({ [shaA]: utf8("a\n") }),
    );
    expect(throughFirst).toBe(5);

    // A later failure must not retroactively touch what an EARLIER, separate flush already
    // acked — this only checks that a clean batch on its own reports its own top seq.
    const { ackThrough: throughSecond } = await applyReplay(
      vault,
      [
        putEvent({ path: "b.md", sha: await contentHash("b\n"), seq: 6 }),
        putEvent({ path: "c.md", sha: await contentHash("c\n"), seq: 7 }),
      ],
      fetcherFor({
        [await contentHash("b\n")]: utf8("b\n"),
        [await contentHash("c\n")]: utf8("c\n"),
      }),
    );
    expect(throughSecond).toBe(7);
  });

  it("skips a put with no sha, rather than fetching nothing", async () => {
    const vault = fakeVault();
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 1, kind: "put", path: "a.md", sha: null, from: null, at_ms: 0 }],
      fetcherFor({}),
    );
    expect(applied).toEqual([]);
    // A malformed event this build will interpret the same way every time — safe to ack
    // past, unlike a fetch failure (see the cases above).
    expect(ackThrough).toBe(1);
  });

  it("skips an event kind this build has never heard of, rather than guessing", async () => {
    // regression-shaped: `Down::Event`'s `kind` is a bare string on the wire (forward-
    // compatible on purpose), and today's wire has no `from` field for a rename at all —
    // so a "rename" kind cannot be applied from this frame alone. Skip, do not invent.
    const vault = fakeVault({ "old.md": "body\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 1, kind: "rename", path: "new.md", sha: null, from: null, at_ms: 0 }],
      fetcherFor({}),
    );
    expect(applied).toEqual([]);
    expect(vault.files.has("old.md")).toBe(true);
    expect(vault.files.has("new.md")).toBe(false);
    // Forward-compatible on purpose (this file's own header) — this build will never want
    // this event no matter how many times it is redelivered, so acking past it is correct.
    expect(ackThrough).toBe(1);
  });

  /**
   * **The vault echoes this device's own writes back**, so a rename this
   * device performed arrives with the source gone and the destination already
   * holding the content. Obsidian's adapter throws on that, a throw withholds
   * the ack, and the cursor stopped before it: measured on a real vault on
   * 2026-09-22, where events 105 and 106 replayed and warned on every
   * reconnect while `syncedCursor` sat at 104.
   *
   * The fakes in this file throw exactly where Obsidian does, which is what
   * makes this expressible at all — the forgiving ones this replaced renamed
   * nothing and reported success.
   */
  it("treats a rename it already performed itself as applied, not as a failure", async () => {
    const body = "body\n";
    const sha = await contentHash(body);
    const vault = fakeVault({ "new.md": body });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 7, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      fetcherFor({}),
    );
    expect(ackThrough).toBe(7);
    // Both halves, as a rename applied the ordinary way reports them: the new
    // path carries the content's hash, the old one carries nothing.
    expect(applied).toEqual([
      { path: "new.md", hash: sha },
      { path: "old.md", hash: null },
    ]);
    expect(vault.text("new.md")).toBe(body);
  });

  it("treats a delete it already performed itself as applied, not as a failure", async () => {
    const vault = fakeVault({ "other.md": "kept\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 8, kind: "delete", path: "gone.md", sha: null, from: null, at_ms: 0 }],
      fetcherFor({}),
    );
    expect(ackThrough).toBe(8);
    expect(applied).toEqual([{ path: "gone.md", hash: null }]);
    expect(vault.text("other.md")).toBe("kept\n");
  });

  /**
   * The echo's other shape: the move happened here, and the destination has
   * moved on since — edited, or written by later events applied while this
   * one was held. It will never hash to this rename's sha again, so waiting
   * for it would hold the ack forever (second review of #158, M2). The ledger
   * learns only that the source is gone; what the destination holds is for
   * the events after this one to record.
   */
  it("acks an echoed rename whose destination has changed since, recording only the source", async () => {
    const sha = await contentHash("theirs\n");
    const vault = fakeVault({ "new.md": "mine\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 9, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      fetcherFor({}),
    );
    expect(ackThrough).toBe(9);
    expect(applied).toEqual([{ path: "old.md", hash: null }]);
    expect(vault.text("new.md")).toBe("mine\n");
  });

  /**
   * The case the review of #158 found untested, and the one the cursor's
   * health depends on: neither path is on disk, so no retry can ever make
   * this applicable. Withholding the ack would stop this device for good.
   */
  it("skips a rename when neither path is on disk, rather than waiting forever", async () => {
    const sha = await contentHash("body\n");
    const vault = fakeVault({ "other.md": "kept\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 4, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      fetcherFor({}),
    );
    expect(applied).toEqual([]);
    expect(ackThrough).toBe(4);
  });

  /**
   * The vault emits a rename onto a path the destination already holds —
   * `pure::decide` checks only the source — so a device holding BOTH files
   * gets one. Obsidian refuses to rename onto an existing path, so a move
   * would throw and stall the cursor forever.
   */
  it("applies a rename onto a path this device already holds", async () => {
    const body = utf8("moved\n");
    const sha = await bytesHash(body);
    const vault = fakeVault({ "old.md": "moved\n", "new.md": "mine\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 5, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      fetcherFor({ [sha]: body }),
    );
    expect(ackThrough).toBe(5);
    expect(vault.text("new.md")).toBe("moved\n");
    expect(vault.files.has("old.md")).toBe(false);
    expect(applied).toEqual([
      { path: "new.md", hash: sha },
      { path: "old.md", hash: null },
    ]);
  });

  /**
   * **The source path is often reused before the echo arrives.** Rename
   * `Untitled.md` to `Foo.md`, press Ctrl+N, and a NEW `Untitled.md` sits
   * unpushed for the settle window. The echo then finds both paths present,
   * and trashing the source by name threw away the note the user had just
   * made (second review of #158, M1). It stays, with no ledger entry, so the
   * next derive pushes it as the new file it is.
   */
  it("does not trash a source path that now holds something other than what moved", async () => {
    const sha = await contentHash("the renamed note\n");
    const vault = fakeVault({
      "Untitled.md": "brand new note\n",
      "Foo.md": "the renamed note\n",
    });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [
        {
          type: "event",
          seq: 50,
          kind: "rename",
          path: "Foo.md",
          sha,
          from: "Untitled.md",
          at_ms: 0,
        },
      ],
      fetcherFor({}),
    );
    expect(ackThrough).toBe(50);
    expect(vault.text("Untitled.md")).toBe("brand new note\n");
    expect(vault.text("Foo.md")).toBe("the renamed note\n");
    // No fetch was needed — the destination already held the bytes — and the
    // source's ledger entry is cleared so the new note reads as unpushed.
    expect(applied).toEqual([
      { path: "Foo.md", hash: sha },
      { path: "Untitled.md", hash: null },
    ]);
  });

  it("skips a rename that names no sha, rather than forgetting the file it lands on", async () => {
    // Unreachable from this vault (`events.rs` declares `content_sha` as a
    // `String`), and accepting it would record `hash: null` for a file that
    // exists — which makes the ledger forget something on disk.
    const vault = fakeVault({ "new.md": "body\n" });
    const { applied, ackThrough } = await applyReplay(
      vault,
      [
        {
          type: "event",
          seq: 6,
          kind: "rename",
          path: "new.md",
          sha: null,
          from: "old.md",
          at_ms: 0,
        },
      ],
      fetcherFor({}),
    );
    expect(applied).toEqual([]);
    expect(ackThrough).toBe(6);
  });

  /**
   * `ApplyDeps.onApplied` is reported PER FILE and immediately, with a
   * measurement behind it (`ApplyDeps`): until the ledger knows about a path,
   * the host's watcher makes it look like a local edit to push back. The echo
   * branches report through the same seam, and nothing asserted it.
   */
  it("reports both halves of an echoed rename to the ledger immediately", async () => {
    const body = "body\n";
    const sha = await contentHash(body);
    const vault = fakeVault({ "new.md": body });
    const seen: { path: string; hash: string | null }[] = [];
    await applyReplay(
      vault,
      [{ type: "event", seq: 7, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      { ...fetcherFor({}), onApplied: (a) => seen.push(a) },
    );
    expect(seen).toEqual([
      { path: "new.md", hash: sha },
      { path: "old.md", hash: null },
    ]);
  });

  it("reports an echoed delete to the ledger immediately", async () => {
    const vault = fakeVault({});
    const seen: { path: string; hash: string | null }[] = [];
    await applyReplay(
      vault,
      [{ type: "event", seq: 8, kind: "delete", path: "gone.md", sha: null, from: null, at_ms: 0 }],
      { ...fetcherFor({}), onApplied: (a) => seen.push(a) },
    );
    expect(seen).toEqual([{ path: "gone.md", hash: null }]);
  });

  it("refuses to write outside the vault or into the config directory", async () => {
    const vault = fakeVault();
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const { applied } = await applyReplay(
      vault,
      [
        putEvent({ path: "../escape.md", sha: shaA }),
        putEvent({ path: ".obsidian/plugins/ctrl-notes-cloud-mcp/main.js", sha: shaB }),
      ],
      fetcherFor({ [shaA]: utf8("x"), [shaB]: utf8("evil") }),
    );
    expect(applied).toEqual([]);
    expect(vault.files.size).toBe(0);
  });

  it("refuses a code path even when the vault names one", async () => {
    const vault = fakeVault();
    const sha = await bytesHash(utf8("evil"));
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "payload.js", sha })],
      fetcherFor({ [sha]: utf8("evil") }),
    );
    expect(applied).toEqual([]);
    expect(vault.files.has("payload.js")).toBe(false);
  });

  it("keeps going after one event fails", async () => {
    const vault = fakeVault();
    const good = await contentHash("yes\n");
    const { applied } = await applyReplay(
      vault,
      [
        putEvent({ path: "bad.md", sha: "not-fetchable" }),
        putEvent({ path: "good.md", sha: good }),
      ],
      fetcherFor({ [good]: utf8("yes\n") }),
    );
    expect(applied.map((a) => a.path)).toEqual(["good.md"]);
  });

  it("keeps going when the filesystem itself throws", async () => {
    // regression-shaped: a folder gone mid-batch or a permission error arrives as a
    // throw, which `applyEvent` cannot see coming and must not let strand later events.
    const vault = fakeVault();
    const boom = await contentHash("x\n");
    const fine = await contentHash("y\n");
    const exploding: VaultFiles = {
      ...vault,
      writeBinary: (path, bytes) =>
        path === "boom.md" ? Promise.reject(new Error("EACCES")) : vault.writeBinary(path, bytes),
    };
    const { applied, ackThrough } = await applyReplay(
      exploding,
      [
        putEvent({ path: "boom.md", sha: boom, seq: 1 }),
        putEvent({ path: "fine.md", sha: fine, seq: 2 }),
      ],
      fetcherFor({ [boom]: utf8("x\n"), [fine]: utf8("y\n") }),
    );
    expect(applied.map((a) => a.path)).toEqual(["fine.md"]);
    // A thrown filesystem error is exactly as unackable as a failed fetch (this file's own
    // header) — the write was never confirmed, so the seq must not be claimed either.
    expect(ackThrough).toBeNull();
  });

  /**
   * **Rule 2, the other half.** A replay is a sequence of things that happened; it must
   * never delete a path just because this replay's events did not mention it — that is
   * what `applySnapshot` below is for, and only for.
   */
  it("does NOT delete local files it does not mention", async () => {
    const vault = fakeVault({ "untouched.md": "still here\n", "a.md": "old\n" });
    const sha = await contentHash("new\n");
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha })],
      fetcherFor({ [sha]: utf8("new\n") }),
    );
    expect(applied.map((a) => a.path)).toEqual(["a.md"]);
    expect(vault.text("untouched.md")).toBe("still here\n");
  });
});

describe("applySnapshot", () => {
  it("fetches content for a path new to the ledger", async () => {
    const vault = fakeVault();
    const sha = await contentHash("theirs\n");
    const files: SnapshotEntry[] = [{ path: "theirs.md", sha }];
    const { applied, complete } = await applySnapshot(
      vault,
      {},
      files,
      fetcherFor({ [sha]: utf8("theirs\n") }),
    );
    expect(vault.text("theirs.md")).toBe("theirs\n");
    expect(applied).toEqual([{ path: "theirs.md", hash: sha }]);
    expect(complete).toBe(true);
  });

  /**
   * **Self-perpetuating without the `exists` guard.** `planSnapshot` names
   * ledger paths the snapshot omits, so a file deleted on another device AND
   * already gone from this disk throws `ENOENT`. That leaves the snapshot
   * incomplete, so it is never acked AND its ledger entry is never cleared,
   * and the next snapshot names the same path again. Found by the review of
   * #158, which caught that the replay's `delete` had been fixed and this had
   * not.
   */
  it("counts a path already gone from disk as trashed, not as a failure", async () => {
    const sha = await contentHash("kept\n");
    const vault = fakeVault({ "keep.md": "kept\n" });
    const { applied, complete } = await applySnapshot(
      vault,
      { "keep.md": sha, "already-deleted.md": "f".repeat(64) },
      [{ path: "keep.md", sha }],
      fetcherFor({}),
    );
    expect(complete).toBe(true);
    expect(applied).toEqual([{ path: "already-deleted.md", hash: null }]);
    expect(vault.text("keep.md")).toBe("kept\n");
  });

  /**
   * Same distinguishing case as `applyReplay`'s above, for the OTHER function `apply.ts`
   * warns never to record a frame's claimed sha.
   */
  it("records a hash derived from what it wrote on the snapshot path too", async () => {
    // Same change as the replay case: a fetch from the wrong address is refused, so the
    // recorded hash and the entry's sha agree — reached by hashing the file, not by
    // trusting the frame.
    const vault = fakeVault();
    const body = "actually these bytes\n";
    const sha = await contentHash(body);
    const files: SnapshotEntry[] = [{ path: "a.md", sha }];
    const { applied } = await applySnapshot(vault, {}, files, fetcherFor({ [sha]: utf8(body) }));
    expect(vault.text("a.md")).toBe(body);
    expect(applied).toEqual([{ path: "a.md", hash: await contentHash(body) }]);
    expect(applied[0]?.hash).toBe(await bytesHash(vault.files.get("a.md") ?? new Uint8Array()));
  });

  it("touches nothing for a path already in step", async () => {
    const sha = await contentHash("same\n");
    const vault = fakeVault({ "a.md": "same\n" });
    const files: SnapshotEntry[] = [{ path: "a.md", sha }];
    const { applied, complete } = await applySnapshot(
      vault,
      { "a.md": sha },
      files,
      fetcherFor({}),
    );
    expect(applied).toEqual([]);
    expect(complete).toBe(true);
    expect(vault.text("a.md")).toBe("same\n");
  });

  /**
   * **Rule 2, and the reason this test and the replay one above are opposites.** A
   * snapshot is authoritative: anything this device believes it last synced and the
   * snapshot never mentions was deleted while this device was away (design §8.4).
   * Silently treating the snapshot as additive would resurrect it.
   */
  it("deletes local files it does not mention", async () => {
    const vault = fakeVault({ "gone-elsewhere.md": "stale\n", "kept.md": "current\n" });
    const sha = await contentHash("current\n");
    // The ledger holds what was actually synced — a placeholder here would
    // now read as an unpushed local edit, which a snapshot must not trash.
    const ledger = { "gone-elsewhere.md": await contentHash("stale\n"), "kept.md": sha };
    const files: SnapshotEntry[] = [{ path: "kept.md", sha }];

    const { applied, complete } = await applySnapshot(vault, ledger, files, fetcherFor({}));

    expect(vault.files.has("gone-elsewhere.md")).toBe(false);
    expect(vault.text("kept.md")).toBe("current\n");
    expect(applied).toContainEqual({ path: "gone-elsewhere.md", hash: null });
    expect(complete).toBe(true);
  });

  it("does not trash a path this device never told the vault about", async () => {
    // A path with no ledger entry was never synced in the first place — it is a local
    // creation, not something deleted elsewhere.
    const vault = fakeVault({ "brand-new.md": "unsent\n" });
    const { applied } = await applySnapshot(vault, {}, [], fetcherFor({}));
    expect(vault.text("brand-new.md")).toBe("unsent\n");
    expect(applied).toEqual([]);
  });

  it("fetches a path whose remote sha has moved on since we last synced", async () => {
    const vault = fakeVault({ "a.md": "old\n" });
    const oldSha = await contentHash("old\n");
    const newSha = await contentHash("new\n");
    const files: SnapshotEntry[] = [{ path: "a.md", sha: newSha }];
    const { applied } = await applySnapshot(
      vault,
      { "a.md": oldSha },
      files,
      fetcherFor({ [newSha]: utf8("new\n") }),
    );
    expect(vault.text("a.md")).toBe("new\n");
    expect(applied).toContainEqual({ path: "a.md", hash: newSha });
  });

  it("drops an attachment on a device that carries none", async () => {
    const vault = fakeVault();
    const files: SnapshotEntry[] = [{ path: "img.png", sha: "a".repeat(64) }];
    const { applied } = await applySnapshot(vault, {}, files, fetcherFor({}), {
      attachments: false,
    });
    expect(applied).toEqual([]);
    expect(vault.files.has("img.png")).toBe(false);
  });

  /**
   * **Blocker fix, the snapshot half.** A partial snapshot must not be acked as if it were
   * complete — `pump.ts` uses `complete` to decide whether to claim the seq at all. Content
   * this build cannot fetch (every `put` today) must leave `complete: false`, exactly like
   * `applyReplay`'s `ackThrough` staying `null`.
   */
  it("is not complete when a fetch fails, even though the rest of the snapshot applied", async () => {
    const vault = fakeVault({ "gone.md": "stale\n" });
    const sha = await contentHash("new\n");
    const ledger = { "gone.md": await contentHash("stale\n") };
    const files: SnapshotEntry[] = [{ path: "new.md", sha }];

    const { applied, complete } = await applySnapshot(vault, ledger, files, fetcherFor({}));

    expect(vault.files.has("gone.md")).toBe(false); // still trashed — this part IS certain
    expect(applied).toEqual([{ path: "gone.md", hash: null }]);
    expect(vault.files.has("new.md")).toBe(false); // never actually fetched
    expect(complete).toBe(false); // so the whole snapshot must not be acked
  });
});

/**
 * **The two halves of the wire must hash the same bytes.**
 *
 * `derive.ts` sends what is on disk (`readBinary` → `bytesHash`), so the vault stores and
 * addresses a file's real bytes. These pin that the inbound half agrees — the half that
 * used to decode text with a non-fatal `new TextDecoder()` and record `contentHash` of the
 * result.
 */
describe("an inbound write is byte-exact, on text as much as on an attachment", () => {
  /** `ef bb bf` + "hello\n" — a Windows- or editor-authored note, which `decodesAsText`
   * accepts because the vault's own `String::from_utf8` accepts it. */
  const bomful = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hello\n")]);

  /**
   * regression, and proven able to fail. The mutation is the deleted text branch, in the
   * smaller form that needs no interface change and is behaviourally identical to it:
   * `const text = new TextDecoder().decode(fetched.value); const bytes = new
   * TextEncoder().encode(text);` then write and hash `bytes`. Re-measured 2026-08-28 on the
   * merge with `main`: exactly 2 of the 549 tests in this suite go red — this one and
   * the next, and nothing `main` brought with it — and this one fails at its
   * FIRST assertion, `expected Uint8Array[ 104, 101, 108, 108, … ] to deeply equal
   * Uint8Array[ 239, 187, 191, 104, … ]`: the BOM is silently gone from the user's file.
   * The hash half of the same defect (`5891b5b5…` recorded where the vault addresses
   * `42c1e65b…`) is not reached here, because vitest stops a case at its first failure —
   * the next case is what pins that half, and it is the isolating one for it.
   */
  it("writes a leading UTF-8 BOM through, and records the hash of the bytes on disk", async () => {
    const vault = fakeVault();
    const sha = await bytesHash(bomful);
    const { applied } = await applyReplay(
      vault,
      [putEvent({ path: "a.md", sha })],
      fetcherFor({ [sha]: bomful }),
    );
    // Byte for byte — not "decodes to the same words", which is the weaker thing a string
    // map was able to say and the reason `fakeVault` holds bytes.
    expect(vault.files.get("a.md")).toEqual(bomful);
    // The ledger entry the next push quotes as its `base`, and the sha the vault holds.
    expect(applied).toEqual([{ path: "a.md", hash: sha }]);
  });

  /**
   * The consequence, and the reason this is a blocker rather than a cosmetic mismatch: a
   * ledger that disagrees with the vault is not self-correcting. `planSnapshot` compares
   * `hashes[path] !== sha`, so a path recorded under the wrong hash is named in `fetch` on
   * every snapshot, forever, rewriting the user's file each time with nothing logged.
   *
   * proven able to fail, and it is the ISOLATING case for the ledger half of the defect:
   * under the same mutation as the case above, this one's earlier assertion
   * (`complete === true`) stays green — the write succeeds, it just wrote the wrong bytes
   * — and the failure lands on the line that matters, `expected [ 'a.md' ] to deeply equal
   * []`. That is the permanent per-snapshot refetch, seen from where the user lives.
   */
  it("settles: the same snapshot arriving twice fetches nothing the second time", async () => {
    const vault = fakeVault();
    const sha = await bytesHash(bomful);
    const files: SnapshotEntry[] = [{ path: "a.md", sha }];
    const deps = fetcherFor({ [sha]: bomful });

    const { applied, complete } = await applySnapshot(vault, {}, files, deps);
    expect(complete).toBe(true);

    // The ledger `main.ts`'s `onApplied` would have persisted from that pass.
    const ledger: Record<string, string> = {};
    for (const a of applied) if (a.hash !== null) ledger[a.path] = a.hash;

    expect(planSnapshot(ledger, files).fetch).toEqual([]);
  });
});

/**
 * The permanence distinction, on both paths.
 *
 * These are the tests the content-fetch design calls its highest value, and the
 * reason is worth restating: the ack boundary is deliberately strict, so a
 * failure that can never be recovered would stop the cursor for the life of the
 * device. Trading a recoverable gap for a permanent stall is not a fix, and
 * without these two pairs nothing would notice the trade.
 */
const permanentlyGone: ApplyDeps = {
  fetchBytes: () => Promise.resolve({ ok: false as const, code: "collected", permanent: true }),
};
const transientlyGone: ApplyDeps = {
  fetchBytes: () => Promise.resolve({ ok: false as const, code: "timeout", permanent: false }),
};

describe("a blob the vault will never supply", () => {
  it("does not stop a replay's ack, so the device is not stalled forever", async () => {
    const vault = fakeVault();
    const r = await applyReplay(
      vault,
      [
        putEvent({ seq: 1, path: "a.md", sha: "gone" }),
        putEvent({ seq: 2, path: "b.md", sha: "gone" }),
      ],
      permanentlyGone,
    );
    expect(r.ackThrough).toBe(2);
    expect(r.applied).toEqual([]);
  });

  it("is NOT written to the ledger, so a later sha for that path still fetches", async () => {
    // If the path were recorded, a subsequent event carrying different content
    // would be diffed against a hash this device never actually holds.
    const vault = fakeVault();
    const r = await applyReplay(vault, [putEvent({ path: "a.md", sha: "gone" })], permanentlyGone);
    expect(r.applied.map((a) => a.path)).not.toContain("a.md");
  });

  // **O3.** The three tests above are why the cursor moves; this is why the
  // user is told. They are the same fact seen from two sides, and shipping
  // only the first half is what made a lost note indistinguishable from a
  // synced one: the status line said "up to date" and it was true.
  it("names the path and the vault's own reason, once, on a replay", async () => {
    const vault = fakeVault();
    const seen: Array<[string, string]> = [];
    await applyReplay(
      vault,
      [
        putEvent({ seq: 1, path: "a.md", sha: "gone" }),
        putEvent({ seq: 2, path: "b.md", sha: "gone" }),
      ],
      { ...permanentlyGone, onUnavailable: (path, reason) => seen.push([path, reason]) },
    );
    expect(seen).toEqual([
      ["a.md", "collected"],
      ["b.md", "collected"],
    ]);
  });

  it("names the path on a snapshot too, which is where a first sync meets one", async () => {
    const vault = fakeVault();
    const seen: string[] = [];
    const files: SnapshotEntry[] = [{ path: "a.md", sha: "gone" }];
    await applySnapshot(vault, {}, files, {
      ...permanentlyGone,
      onUnavailable: (path) => seen.push(path),
    });
    expect(seen).toEqual(["a.md"]);
  });

  it("does NOT report a transient failure, which would count a retry as a loss", async () => {
    const vault = fakeVault();
    const seen: string[] = [];
    await applyReplay(vault, [putEvent({ path: "a.md", sha: "gone" })], {
      ...transientlyGone,
      onUnavailable: (path) => seen.push(path),
    });
    expect(seen).toEqual([]);
  });

  it("leaves a snapshot complete, so it is acked rather than retried forever", async () => {
    const vault = fakeVault();
    const files: SnapshotEntry[] = [{ path: "a.md", sha: "gone" }];
    const r = await applySnapshot(vault, {}, files, permanentlyGone);
    expect(r.complete).toBe(true);
  });
});

describe("a blob that is only temporarily unreachable", () => {
  it("DOES stop a replay's ack, because retrying will recover it", async () => {
    const vault = fakeVault();
    const r = await applyReplay(
      vault,
      [
        putEvent({ seq: 1, path: "a.md", sha: "later" }),
        putEvent({ seq: 2, path: "b.md", sha: "later" }),
      ],
      transientlyGone,
    );
    expect(r.ackThrough).toBeNull();
  });

  it("leaves a snapshot INCOMPLETE, so it is not acked", async () => {
    const vault = fakeVault();
    const r = await applySnapshot(vault, {}, [{ path: "a.md", sha: "later" }], transientlyGone);
    expect(r.complete).toBe(false);
  });

  it("is the default when a fetcher says nothing about permanence", async () => {
    // `permanent` is optional on the wire between these two modules, and the
    // safe reading of silence is "try again" — never "give up on this content".
    const vault = fakeVault();
    const r = await applySnapshot(vault, {}, [{ path: "a.md", sha: "?" }], fetcherFor({}));
    expect(r.complete).toBe(false);
  });
});

describe("bytes that do not match the sha they were fetched for", () => {
  /**
   * Content is addressed by its own hash, so a mismatch is checkable. It has to
   * be checked: without it the wrong bytes are written to disk AND recorded in
   * the ledger under their own hash, and the next derive reads that as a local
   * edit and pushes the corruption back up as the vault's content.
   */
  const liar: ApplyDeps = {
    fetchBytes: () => Promise.resolve({ ok: true as const, value: utf8("not what you asked for") }),
  };

  it("are not written to disk", async () => {
    const vault = fakeVault();
    await applyReplay(vault, [putEvent({ path: "a.md", sha: "a".repeat(64) })], liar);
    expect(vault.files.get("a.md")).toBeUndefined();
  });

  it("do not enter the ledger, so nothing pushes them back up", async () => {
    const vault = fakeVault();
    const r = await applyReplay(vault, [putEvent({ path: "a.md", sha: "a".repeat(64) })], liar);
    expect(r.applied).toEqual([]);
  });

  it("stop the ack as TRANSIENT, because a retry may well succeed", async () => {
    const vault = fakeVault();
    const r = await applyReplay(vault, [putEvent({ path: "a.md", sha: "a".repeat(64) })], liar);
    expect(r.ackThrough).toBeNull();
  });
});

/**
 * **An inbound change never overwrites or removes an edit this device has not
 * uploaded.** Measured on a real Obsidian against the local stack on
 * 2026-09-22: an edit made offline, an edit made offline against a remote
 * delete, and a save racing a remote edit were each gone from both ends, with
 * the status line reading "up to date". The file stays; its ledger entry stays
 * the base it was edited from; the upload that follows meets the other
 * version in the vault's three-way merge (`merge::ancestor_for_upload`).
 */
describe("an unpushed local edit survives inbound changes", () => {
  /** `ledger` is what this device last synced; the fake disk may differ. */
  const withLedger = (
    ledger: Record<string, string>,
    content: Record<string, Uint8Array> = {},
  ): ApplyDeps & { kept: string[]; seen: { path: string; hash: string | null }[] } => {
    const kept: string[] = [];
    const seen: { path: string; hash: string | null }[] = [];
    return {
      ...fetcherFor(content),
      ledger: () => ledger,
      onKept: (path) => kept.push(path),
      onApplied: (a) => seen.push(a),
      kept,
      seen,
    };
  };

  it("does not overwrite it with an inbound put, and has it uploaded", async () => {
    const theirs = utf8("remote version\n");
    const sha = await bytesHash(theirs);
    const vault = fakeVault({ "n.md": "local edit\n" });
    const deps = withLedger({ "n.md": await contentHash("synced\n") }, { [sha]: theirs });
    const { ackThrough } = await applyReplay(
      vault,
      [putEvent({ path: "n.md", sha, seq: 3 })],
      deps,
    );
    expect(vault.text("n.md")).toBe("local edit\n");
    expect(deps.kept).toEqual(["n.md"]);
    // The base stays what it was edited from — no ledger write for the path.
    expect(deps.seen).toEqual([]);
    // Acked: the vault merges against the declared base, not the cursor.
    expect(ackThrough).toBe(3);
  });

  it("records, without fetching, a put whose bytes are already on disk", async () => {
    const body = "same\n";
    const sha = await contentHash(body);
    const vault = fakeVault({ "n.md": body });
    // No content offered: a fetch here would come back not_found and block.
    const deps = withLedger({});
    const { ackThrough } = await applyReplay(
      vault,
      [putEvent({ path: "n.md", sha, seq: 4 })],
      deps,
    );
    expect(ackThrough).toBe(4);
    expect(deps.seen).toEqual([{ path: "n.md", hash: sha }]);
    expect(deps.kept).toEqual([]);
  });

  it("keeps an edited file an inbound delete names — edit beats delete", async () => {
    const vault = fakeVault({ "n.md": "local edit\n" });
    const deps = withLedger({ "n.md": await contentHash("synced\n") });
    const { ackThrough } = await applyReplay(
      vault,
      [{ type: "event", seq: 5, kind: "delete", path: "n.md", sha: null, from: null, at_ms: 0 }],
      deps,
    );
    expect(vault.text("n.md")).toBe("local edit\n");
    expect(deps.kept).toEqual(["n.md"]);
    // The vault holds nothing there now, so the edit uploads as a new file.
    expect(deps.seen).toEqual([{ path: "n.md", hash: null }]);
    expect(ackThrough).toBe(5);
  });

  it("still trashes a file an inbound delete names when it is unchanged since sync", async () => {
    const vault = fakeVault({ "n.md": "synced\n" });
    const deps = withLedger({ "n.md": await contentHash("synced\n") });
    await applyReplay(
      vault,
      [{ type: "event", seq: 6, kind: "delete", path: "n.md", sha: null, from: null, at_ms: 0 }],
      deps,
    );
    expect(vault.files.has("n.md")).toBe(false);
    expect(deps.kept).toEqual([]);
  });

  // A rename into a path this device refuses (a top-level dot-folder) takes the file out of
  // what it syncs. Skipped, the source stayed on disk and in the ledger, and an edit to it
  // uploaded a second copy. It is a delete of the source instead, under the delete's rules.
  it("treats a rename into a refused path as a delete of its source", async () => {
    const vault = fakeVault({ "notes/a.md": "synced\n" });
    const sha = await contentHash("synced\n");
    const deps = withLedger({ "notes/a.md": sha });
    const { ackThrough } = await applyReplay(
      vault,
      [
        {
          type: "event",
          seq: 7,
          kind: "rename",
          path: ".archive/a.md",
          sha,
          from: "notes/a.md",
          at_ms: 0,
        },
      ],
      deps,
    );
    expect(vault.files.has("notes/a.md")).toBe(false);
    expect(vault.files.has(".archive/a.md")).toBe(false);
    expect(deps.seen).toEqual([{ path: "notes/a.md", hash: null }]);
    expect(ackThrough).toBe(7);
  });

  it("keeps an edited source a rename into a refused path names — edit beats delete", async () => {
    const vault = fakeVault({ "notes/a.md": "local edit\n" });
    const deps = withLedger({ "notes/a.md": await contentHash("synced\n") });
    await applyReplay(
      vault,
      [
        {
          type: "event",
          seq: 8,
          kind: "rename",
          path: ".archive/a.md",
          sha: await contentHash("synced\n"),
          from: "notes/a.md",
          at_ms: 0,
        },
      ],
      deps,
    );
    expect(vault.text("notes/a.md")).toBe("local edit\n");
    expect(deps.kept).toEqual(["notes/a.md"]);
    expect(deps.seen).toEqual([{ path: "notes/a.md", hash: null }]);
  });

  it("does not overwrite an edited destination with an inbound rename", async () => {
    const moved = utf8("moved\n");
    const sha = await bytesHash(moved);
    const vault = fakeVault({ "old.md": "moved\n", "new.md": "local edit\n" });
    const deps = withLedger({ "new.md": await contentHash("synced\n") }, { [sha]: moved });
    await applyReplay(
      vault,
      [{ type: "event", seq: 7, kind: "rename", path: "new.md", sha, from: "old.md", at_ms: 0 }],
      deps,
    );
    expect(vault.text("new.md")).toBe("local edit\n");
    expect(deps.kept).toEqual(["new.md"]);
  });

  it("keeps an edited file a snapshot would overwrite, and still completes", async () => {
    const theirs = utf8("vault version\n");
    const sha = await bytesHash(theirs);
    const vault = fakeVault({ "n.md": "local edit\n" });
    const ledger = { "n.md": await contentHash("synced\n") };
    const deps = withLedger(ledger, { [sha]: theirs });
    const { complete } = await applySnapshot(vault, ledger, [{ path: "n.md", sha }], deps);
    expect(vault.text("n.md")).toBe("local edit\n");
    expect(deps.kept).toEqual(["n.md"]);
    expect(complete).toBe(true);
  });

  /**
   * A device pairing onto a folder that already holds the vault's files: the
   * ledger is empty, but the bytes match. That is in sync, not an unpushed
   * edit — recorded without a fetch, and not kept.
   */
  it("records a file a snapshot names whose bytes already match, with an empty ledger", async () => {
    const sha = await contentHash("same\n");
    const vault = fakeVault({ "n.md": "same\n" });
    const deps = withLedger({});
    const { applied, complete } = await applySnapshot(vault, {}, [{ path: "n.md", sha }], deps);
    expect(applied).toEqual([{ path: "n.md", hash: sha }]);
    expect(deps.kept).toEqual([]);
    expect(complete).toBe(true);
  });

  it("keeps an edited file a snapshot no longer names", async () => {
    const vault = fakeVault({ "n.md": "local edit\n" });
    const ledger = { "n.md": await contentHash("synced\n") };
    const deps = withLedger(ledger);
    const { applied, complete } = await applySnapshot(vault, ledger, [], deps);
    expect(vault.text("n.md")).toBe("local edit\n");
    expect(applied).toEqual([{ path: "n.md", hash: null }]);
    expect(deps.kept).toEqual(["n.md"]);
    expect(complete).toBe(true);
  });
});

describe("a save made while the replacement is being fetched", () => {
  /**
   * The check before the fetch is not enough: the fetch is a network round
   * trip, and a save inside it is exactly the unpushed edit PL9 protects
   * (review of #168). The disk is checked again just before the write.
   */
  it("is not overwritten by the inbound put that was fetching", async () => {
    const theirs = utf8("remote\n");
    const sha = await bytesHash(theirs);
    const synced = await contentHash("synced\n");
    const vault = fakeVault({ "n.md": "synced\n" });
    const kept: string[] = [];
    const deps: ApplyDeps = {
      fetchBytes: async () => {
        // The user saves while the bytes are in flight.
        await vault.writeBinary("n.md", utf8("saved mid-fetch\n"));
        return { ok: true as const, value: theirs };
      },
      ledger: () => ({ "n.md": synced }),
      onKept: (p) => kept.push(p),
    };
    const { ackThrough } = await applyReplay(
      vault,
      [putEvent({ path: "n.md", sha, seq: 2 })],
      deps,
    );
    expect(vault.text("n.md")).toBe("saved mid-fetch\n");
    expect(kept).toEqual(["n.md"]);
    expect(ackThrough).toBe(2);
  });

  it("is not overwritten by a pull after a merged push", async () => {
    const merged = utf8("merged\n");
    const mergedSha = await bytesHash(merged);
    const vault = fakeVault({ "n.md": "pushed\n" });
    const r = await pullIfUnchanged(vault, "n.md", await contentHash("pushed\n"), mergedSha, {
      fetchBytes: async () => {
        await vault.writeBinary("n.md", utf8("saved mid-fetch\n"));
        return { ok: true as const, value: merged };
      },
    });
    expect(r).toBe("moved-on");
    expect(vault.text("n.md")).toBe("saved mid-fetch\n");
  });
});

describe("pullIfUnchanged — the vault's version after a merged push", () => {
  it("writes the vault's version while the disk still holds what was pushed", async () => {
    const merged = utf8("merged\n");
    const mergedSha = await bytesHash(merged);
    const vault = fakeVault({ "n.md": "pushed\n" });
    const r = await pullIfUnchanged(
      vault,
      "n.md",
      await contentHash("pushed\n"),
      mergedSha,
      fetcherFor({ [mergedSha]: merged }),
    );
    expect(vault.text("n.md")).toBe("merged\n");
    expect(r).toEqual({ path: "n.md", hash: mergedSha });
  });

  it("leaves a file the user has edited again since the push", async () => {
    const merged = utf8("merged\n");
    const mergedSha = await bytesHash(merged);
    const vault = fakeVault({ "n.md": "edited again\n" });
    const r = await pullIfUnchanged(
      vault,
      "n.md",
      await contentHash("pushed\n"),
      mergedSha,
      fetcherFor({ [mergedSha]: merged }),
    );
    expect(r).toBe("moved-on");
    expect(vault.text("n.md")).toBe("edited again\n");
  });
});
