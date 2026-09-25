// Task 10's tests.

import { describe, expect, it, vi } from "vitest";
import type { DownApplied, DownEvent, DownRefused, DownSnapshot, Up } from "../wire.ts";
import { MAX_FRAME_BYTES } from "../wire.ts";
import type { ApplyDeps, VaultFiles } from "./apply.ts";
import { contentHash } from "./hash.ts";
import { Pump, type PumpDeps, type SyncTransport } from "./pump.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A fake disk holding bytes — `apply.ts` writes every path with `writeBinary` now, text
 * included, and a double that still took a string could not receive one. `text()` keeps the
 * cases below reading as they did. */
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
    // Throwing where Obsidian's adapter throws — see `apply.test.ts`'s copy.
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
      const body = files.get(from) as Uint8Array;
      files.delete(from);
      files.set(to, body);
      return Promise.resolve();
    },
  };
};

const fetcherFor = (content: Record<string, Uint8Array>): ApplyDeps["fetchBytes"] => {
  return (sha) => {
    const value = content[sha];
    return value
      ? Promise.resolve({ ok: true as const, value })
      : Promise.resolve({ ok: false as const, code: "not_found" });
  };
};

/** A transport that just records what it was asked to do — no socket, no vault. */
function fakeTransport(): SyncTransport & { readonly sent: Up[]; readonly binary: Uint8Array[] } {
  const sent: Up[] = [];
  const binary: Uint8Array[] = [];
  return {
    sent,
    binary,
    send: (up) => sent.push(up),
    sendBinary: (bytes) => binary.push(bytes),
    noteAck: vi.fn(),
  };
}

function harness(overrides: Partial<PumpDeps> = {}) {
  const vault = fakeVault();
  const transport = fakeTransport();
  const applied: unknown[][] = [];
  const cursors: number[] = [];
  const refusals: DownRefused[] = [];
  let ledger: Record<string, string> = {};
  const deps: PumpDeps = {
    transport,
    vault,
    fetchBytes: fetcherFor({}),
    ledger: () => ledger,
    onApplied: (a) => applied.push([...a]),
    onCursor: (seq) => cursors.push(seq),
    onRefused: (r) => refusals.push(r),
    ...overrides,
  };
  const pump = new Pump(deps);
  return {
    pump,
    vault,
    transport,
    applied,
    cursors,
    refusals,
    setLedger: (h: Record<string, string>) => {
      ledger = h;
    },
  };
}

const event = (
  over: Partial<DownEvent> & { path: string; sha: string; seq: number },
): DownEvent => ({
  type: "event",
  kind: "put",
  from: null,
  at_ms: 0,
  ...over,
});

describe("Pump — inbound", () => {
  it("an inbound event is applied and then acked", async () => {
    const sha = await contentHash("hello\n");
    const h = harness({ fetchBytes: fetcherFor({ [sha]: utf8("hello\n") }) });

    await h.pump.handleDown(event({ path: "a.md", sha, seq: 5 }));

    expect(h.vault.text("a.md")).toBe("hello\n");
    expect(h.transport.sent).toEqual([{ type: "ack", seq: 5 }]);
    expect(h.transport.noteAck).toHaveBeenCalledWith(5);
    expect(h.cursors).toEqual([5]);
    // Flattened, not per call. A write now reports the moment it lands AND is
    // included in the batch summary, so the ledger hears about it twice — which
    // is idempotent, and deliberate: see the next test for why the early one
    // has to exist.
    expect(h.applied.flat()).toContainEqual({ path: "a.md", hash: sha });
  });

  it("reports a write to the ledger BEFORE the batch finishes", async () => {
    // The bug this pins: the host's watcher fires on every file this device
    // writes, and `derive` decides whether to push by comparing the file's hash
    // against the ledger. While the ledger lagged a whole batch behind, every
    // applied file looked like a local edit and was pushed straight back —
    // measured on a 332-file snapshot, 102 were pushed and refused ("that path
    // already exists and needs base_sha"), and the resulting upload storm
    // starved the fetches on the same socket until they timed out.
    //
    // So this asserts ORDER, not totals: the first file must reach the ledger
    // while later files are still being fetched.
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const seen: string[] = [];
    const h = harness({
      fetchBytes: (sha: string) => {
        // Record what the ledger already knows at the moment each fetch starts.
        seen.push(JSON.stringify(h.applied.flat()));
        const body = sha === shaA ? "a\n" : "b\n";
        return Promise.resolve({ ok: true as const, value: utf8(body) });
      },
    });

    await h.pump.handleDown(event({ path: "a.md", sha: shaA, seq: 1 }));
    await h.pump.handleDown(event({ path: "b.md", sha: shaB, seq: 2 }));

    // By the time b.md is fetched, a.md must already be in the ledger.
    expect(seen[seen.length - 1]).toContain("a.md");
  });

  /**
   * **The cursor must not step over an event that failed in an EARLIER batch.**
   * `applyReplay`'s `blocked` lives inside one call, so before `Pump.outstanding`
   * a later clean batch acked its own highest seq — and since the vault resumes
   * from the acked cursor, the failed event was never offered again. Measured
   * on the live vault 2026-09-22 and found by the review of #158: a rename this
   * device could not apply at 105 was acked past when an unrelated event
   * arrived at 107.
   */
  it("does not ack past an event an earlier batch could not apply", async () => {
    // Content-addressed, so the bytes that later become available must hash to
    // the sha the event named — anything else is refused, correctly.
    const missing = await contentHash("blocked\n");
    const sha = await contentHash("later\n");
    // Mutable, so the blocked content can become available the way it would
    // when a transient failure clears.
    const content: Record<string, Uint8Array> = { [sha]: utf8("later\n") };
    const h = harness({
      fetchBytes: (want) => {
        const value = content[want];
        return Promise.resolve(
          value ? { ok: true as const, value } : { ok: false as const, code: "not_found" },
        );
      },
    });

    // Batch one: the content is not available, so nothing may be acked.
    await h.pump.handleDown(event({ path: "blocked.md", sha: missing, seq: 105 }));
    expect(h.cursors).toEqual([]);

    // Batch two applies cleanly — and must NOT carry the ack past 105.
    await h.pump.handleDown(event({ path: "later.md", sha, seq: 107 }));
    expect(h.vault.text("later.md")).toBe("later\n");
    expect(h.cursors).toEqual([]);
    expect(h.transport.sent.filter((u) => u.type === "ack")).toEqual([]);

    // The vault redelivers from the unmoved cursor. Once the blocked event
    // lands, the cursor is free to move again.
    content[missing] = utf8("blocked\n");
    await h.pump.handleDown(event({ path: "blocked.md", sha: missing, seq: 105 }));
    await h.pump.handleDown(event({ path: "later.md", sha, seq: 107 }));
    expect(h.cursors).toEqual([105, 107]);
  });

  it("acking is batched, not one frame per event", async () => {
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const shaC = await contentHash("c\n");
    const h = harness({
      fetchBytes: fetcherFor({ [shaA]: utf8("a\n"), [shaB]: utf8("b\n"), [shaC]: utf8("c\n") }),
    });

    // All three arrive before the microtask flush runs — the way three `Down::Event`
    // frames processed inside one socket read would. None of these three calls is
    // individually awaited — awaiting between them would leave only one event in the
    // queue each time and defeat the very batching under test.
    h.pump.handleDown(event({ path: "a.md", sha: shaA, seq: 1 }));
    h.pump.handleDown(event({ path: "b.md", sha: shaB, seq: 2 }));
    await h.pump.handleDown(event({ path: "c.md", sha: shaC, seq: 7 }));

    const acks = h.transport.sent.filter((u) => u.type === "ack");
    expect(acks).toEqual([{ type: "ack", seq: 7 }]);
  });

  /**
   * **Rule 2, and the mirror of "a snapshot trashes what the ledger no longer holds"
   * below.** An `event` frame must route through `applyReplay`, never `applySnapshot` — the
   * ledger holding a path no event names is completely ordinary (a note Obsidian Sync has
   * not brought down yet, or simply untouched), and conflating the two handlers would trash
   * it as if a snapshot had just said it was gone.
   */
  it("an inbound event never trashes a path the ledger holds that it does not mention", async () => {
    const sha = await contentHash("hello\n");
    const h = harness({ fetchBytes: fetcherFor({ [sha]: utf8("hello\n") }) });
    h.vault.files.set("untouched.md", utf8("still here\n"));
    h.setLedger({ "untouched.md": "deadbeef".repeat(8) });

    await h.pump.handleDown(event({ path: "a.md", sha, seq: 5 }));

    expect(h.vault.text("untouched.md")).toBe("still here\n");
    expect(h.vault.text("a.md")).toBe("hello\n");
  });

  it("a snapshot trashes what the ledger no longer holds and fetches what changed", async () => {
    const sha = await contentHash("new\n");
    const h = harness({ fetchBytes: fetcherFor({ [sha]: utf8("new\n") }) });
    h.vault.files.set("gone.md", utf8("should be trashed\n"));
    h.setLedger({ "gone.md": await contentHash("should be trashed\n") });

    const down: DownSnapshot = {
      type: "snapshot",
      seq: 99,
      more: false,
      files: [{ path: "new.md", sha }],
    };
    await h.pump.handleDown(down);

    expect(h.vault.files.has("gone.md")).toBe(false);
    expect(h.vault.text("new.md")).toBe("new\n");
    expect(h.transport.sent).toEqual([{ type: "ack", seq: 99 }]);
    expect(h.cursors).toEqual([99]);
  });
});

describe("Pump — outbound", () => {
  const put = (path: string, content: Uint8Array, hash: string) => ({
    op: "put" as const,
    path,
    base: null,
    content,
    hash,
  });

  it("a local change is sent as put with its base_sha", async () => {
    const h = harness();
    const content = utf8("hi\n");
    const hash = await contentHash("hi\n");
    const donePromise = h.pump.push({ op: "put", path: "a.md", base: "oldsha", content, hash });

    expect(h.transport.sent).toEqual([
      { type: "put", path: "a.md", base_sha: "oldsha", sha: hash, bytes: content.byteLength },
    ]);

    h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: hash });
    await donePromise;
  });

  it("content follows the put header as binary frames", async () => {
    const h = harness();
    const content = new Uint8Array(600_000).fill(7); // several PUT_CHUNK_BYTES-sized pieces
    const hash = await contentHash("irrelevant, only shapes matter here");
    const donePromise = h.pump.push(put("big.bin", content, hash));

    expect(h.transport.sent[0]?.type).toBe("put");
    expect(h.transport.binary.length).toBeGreaterThan(1);
    const reassembled = new Uint8Array(content.byteLength);
    let offset = 0;
    for (const piece of h.transport.binary) {
      reassembled.set(piece, offset);
      offset += piece.byteLength;
    }
    expect(reassembled).toEqual(content);

    h.pump.handleDown({ type: "applied", path: "big.bin", seq: 1, sha: hash });
    await donePromise;
  });

  it("refuses a change over MAX_FRAME_BYTES rather than send it", () => {
    const h = harness();
    const content = new Uint8Array(MAX_FRAME_BYTES + 1);
    expect(() => h.pump.push(put("huge.bin", content, "sha"))).toThrow(/MAX_FRAME_BYTES/);
  });

  it("a refused put surfaces the current sha for the next attempt", async () => {
    const h = harness();
    const content = utf8("x\n");
    const hash = await contentHash("x\n");
    const outcomePromise = h.pump.push(put("a.md", content, hash));

    const refusal: DownRefused = {
      type: "refused",
      path: "a.md",
      reason: "we both changed this",
      current_sha: "cccc".repeat(16),
    };
    h.pump.handleDown(refusal);
    const outcome = await outcomePromise;

    expect(outcome.refused).toEqual(refusal);
    expect(h.refusals).toEqual([refusal]);
  });

  /**
   * **Minor fix.** An `applied` reply must NOT advance the persisted cursor by itself — the
   * vault echoes this device's own write back as an ordinary `Down::Event` to the very
   * connection that authored it (`run`'s `cursor` in `apps/vault/src/http/routes/sync.rs`
   * only ever advances inside `drain`, which every connection's `sync_notify` subscription
   * reaches, author included). Advancing early risked `syncState.cursor` outrunning an
   * event from ANOTHER device racing the same notify wakeup — narrow, silent, and
   * unrecoverable if the plugin unloaded in that exact window. `flushEvents` (below) is
   * what actually advances it now, once the echo has landed.
   */
  it("an applied frame alone does not advance the cursor", async () => {
    const h = harness();
    const content = utf8("x\n");
    const hash = await contentHash("x\n");
    const donePromise = h.pump.push(put("a.md", content, hash));

    const applied: DownApplied = { type: "applied", path: "a.md", seq: 4821, sha: hash };
    h.pump.handleDown(applied);
    await donePromise;

    expect(h.cursors).toEqual([]);
  });

  it("the cursor advances once the vault's own echo of that write actually arrives", async () => {
    const content = utf8("x\n");
    const hash = await contentHash("x\n");
    const h = harness({ fetchBytes: fetcherFor({ [hash]: content }) });
    const donePromise = h.pump.push(put("a.md", content, hash));
    h.pump.handleDown({ type: "applied", path: "a.md", seq: 4821, sha: hash });
    await donePromise;
    expect(h.cursors).toEqual([]); // still nothing, per the case above

    // The echo: an ordinary `Down::Event` naming the SAME path and sha this device just
    // pushed, at the same seq the `applied` reply carried.
    await h.pump.handleDown(event({ path: "a.md", sha: hash, seq: 4821 }));

    expect(h.cursors).toEqual([4821]);
  });

  it("a second push waits behind the first — one outstanding at a time", async () => {
    const h = harness();
    const hashA = await contentHash("a\n");
    const hashB = await contentHash("b\n");
    const doneA = h.pump.push(put("a.md", utf8("a\n"), hashA));
    const doneB = h.pump.push(put("b.md", utf8("b\n"), hashB));

    // Only the first has been sent — the wire has no batch to distinguish two outstanding
    // replies from each other.
    expect(h.transport.sent).toHaveLength(1);
    expect((h.transport.sent[0] as { path: string }).path).toBe("a.md");

    h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: hashA });
    await doneA;
    expect(h.transport.sent).toHaveLength(2);
    expect((h.transport.sent[1] as { path: string }).path).toBe("b.md");

    h.pump.handleDown({ type: "applied", path: "b.md", seq: 2, sha: hashB });
    await doneB;
  });

  /**
   * §11: content addressing makes a retry a no-op. A dropped connection mid-upload must
   * not produce two events when the plugin retries — this is the property `resume()`
   * exists for (see its own doc comment).
   */
  it("a retried upload after a drop produces one event, not two", async () => {
    const h = harness();
    const content = utf8("x\n");
    const hash = await contentHash("x\n");
    const donePromise = h.pump.push(put("a.md", content, hash));

    const putFrames = () => h.transport.sent.filter((u) => u.type === "put");
    expect(putFrames()).toHaveLength(1); // sent once, on the connection that then dropped

    // The connection died before any reply arrived. `main.ts` calls `resume()` once the
    // NEXT connection is ready — never `push()` again, which would be a second `Change`
    // for the same edit.
    h.pump.resume();
    expect(putFrames()).toHaveLength(2); // sent again, same change — not a new one queued
    expect(putFrames()[0]).toEqual(putFrames()[1]); // byte-identical: the retry IS the original

    h.pump.handleDown({ type: "applied", path: "a.md", seq: 9, sha: hash });
    const outcome = await donePromise;
    expect(outcome.hashes).toEqual({ "a.md": hash });
  });

  /**
   * A send that throws — `SyncSocket` before its handshake completes — reached nothing, so
   * the change is not in flight. Before this, the head stayed queued with `inFlight` set
   * while its promise rejected: the caller re-derived the path, and the next `resume()` also
   * re-sent the stale head, so one edit went up twice.
   *
   * **Proven able to fail** by removing the `catch` in `trySend`: `resume()` sends the
   * rejected change.
   */
  it("a send that throws rejects the push and leaves nothing for resume() to re-send", async () => {
    const h = harness();
    const send = h.transport.send;
    let ready = false;
    h.transport.send = (up) => {
      if (!ready) throw new Error("cannot send before the sync handshake completes");
      send(up);
    };
    const hash = await contentHash("x\n");
    await expect(h.pump.push(put("a.md", utf8("x\n"), hash))).rejects.toThrow();
    expect(h.pump.hasOutstanding()).toBe(false);

    ready = true;
    h.pump.resume();
    expect(h.transport.sent.filter((u) => u.type === "put")).toEqual([]);
  });

  /**
   * **Blocker fix.** Before `abandon()` existed, discarding a `Pump` with a push still
   * outstanding (`main.ts`'s `disconnectSyncing`, reached from a terminal closing, unpair,
   * or unload) left this promise unsettled forever — `pushTouched` awaits it directly, so
   * `this.syncing` latched `true` for the rest of the plugin instance's life and every later
   * edit silently stopped pushing. See `main.test.ts`'s end-to-end version of this same
   * scenario.
   */
  describe("abandon", () => {
    it("rejects the outstanding push rather than leaving it unsettled", async () => {
      const h = harness();
      const hash = await contentHash("x\n");
      const outcome = h.pump.push(put("a.md", utf8("x\n"), hash));

      h.pump.abandon();

      await expect(outcome).rejects.toThrow();
    });

    it("rejects everything still queued behind the head, not only the head", async () => {
      const h = harness();
      const hashA = await contentHash("a\n");
      const hashB = await contentHash("b\n");
      const a = h.pump.push(put("a.md", utf8("a\n"), hashA));
      const b = h.pump.push(put("b.md", utf8("b\n"), hashB));

      h.pump.abandon();

      await expect(a).rejects.toThrow();
      await expect(b).rejects.toThrow();
    });
  });
});

describe("a snapshot that arrives in pages", () => {
  /**
   * **The rule the whole mechanism rests on.** A snapshot is authoritative —
   * `applySnapshot` trashes any path it does not name — so applying page one of
   * three deletes everything in pages two and three. Nothing may touch the disk
   * until `more: false`.
   */
  const page = (files: Array<{ path: string; sha: string }>, more: boolean, seq = 9) =>
    ({ type: "snapshot", seq, files, more }) as DownSnapshot;

  it("writes nothing while more pages are still coming", async () => {
    const shaA = await contentHash("a\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n") }) });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true));
    expect(h.vault.files.size).toBe(0);
    expect(h.transport.sent).toEqual([]);
  });

  it("does not trash a path named only in a LATER page", async () => {
    // The destructive case, stated directly: `b.md` is in the ledger and
    // appears in page two. If page one were applied on its own it would be
    // read as "deleted while away" and trashed.
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n"), [shaB]: utf8("b\n") }) });
    // Both files already on disk and in the ledger, which is what makes page
    // one destructive if it were applied alone: `b.md` is not in it.
    h.vault.files.set("a.md", utf8("a\n"));
    h.vault.files.set("b.md", utf8("b\n"));
    h.setLedger({ "a.md": shaA, "b.md": shaB });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true));
    expect(h.vault.text("b.md")).toBe("b\n");
    await h.pump.handleDown(page([{ path: "b.md", sha: shaB }], false));
    expect(h.vault.text("b.md")).toBe("b\n");
  });

  it("applies the accumulated set once the last page lands", async () => {
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n"), [shaB]: utf8("b\n") }) });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true));
    await h.pump.handleDown(page([{ path: "b.md", sha: shaB }], false));
    expect(h.vault.text("a.md")).toBe("a\n");
    expect(h.vault.text("b.md")).toBe("b\n");
  });

  it("acks only after the last page", async () => {
    const shaA = await contentHash("a\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n") }) });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true));
    expect(h.cursors).toEqual([]);
    await h.pump.handleDown(page([], false));
    expect(h.cursors).toEqual([9]);
  });

  it("discards a half-received snapshot when the connection drops", async () => {
    // Resuming across a dead socket would apply a list assembled from two
    // different points in time, and a snapshot is authoritative.
    const shaA = await contentHash("a\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n") }) });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true));
    h.pump.forgetSnapshotPages();
    await h.pump.handleDown(page([], false));
    // Only what the final page named — the abandoned page is gone, so nothing
    // from it is written.
    expect(h.vault.files.get("a.md")).toBeUndefined();
  });

  it("discards the accumulation when a page for a different seq arrives", async () => {
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const h = harness({ fetchBytes: fetcherFor({ [shaA]: utf8("a\n"), [shaB]: utf8("b\n") }) });
    await h.pump.handleDown(page([{ path: "a.md", sha: shaA }], true, 9));
    await h.pump.handleDown(page([{ path: "b.md", sha: shaB }], false, 10));
    expect(h.vault.text("b.md")).toBe("b\n");
    expect(h.vault.files.get("a.md")).toBeUndefined();
  });
});

/**
 * **The cursor never moves past an event this device could not apply** —
 * the rule the second review of #158 found the pump still breaking in three
 * ways the first round's test could not see: overlapping flushes, a single
 * `blockedAt` slot, and a block with no way to be released on a live
 * connection.
 */
describe("Pump — nothing is acked past what failed", () => {
  const snapshot = (files: Array<{ path: string; sha: string }>, seq: number) =>
    ({ type: "snapshot", seq, files, more: false }) as DownSnapshot;

  /** A vault whose writes to one path always throw, as EACCES would. */
  const refusing = (path: string): VaultFiles => {
    const v = fakeVault();
    return {
      ...v,
      writeBinary: (p, bytes) =>
        p === path
          ? Promise.reject(new Error("EACCES: permission denied"))
          : v.writeBinary(p, bytes),
    };
  };

  /**
   * B1. `main.ts` hands frames over without awaiting them, so a flush
   * waiting on a fetch overlapped the next one and the fast later event was
   * acked while the slow earlier one was still in flight. Every other test
   * here awaits each `handleDown`, which serialises them by accident — this
   * one does not.
   */
  it("does not ack a fast later event while a slow earlier one is still in flight", async () => {
    const slow = await contentHash("slow\n");
    const fast = await contentHash("fast\n");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      fetchBytes: async (sha) => {
        if (sha === slow) {
          await gate;
          return { ok: false as const, code: "timeout" };
        }
        return { ok: true as const, value: utf8("fast\n") };
      },
    });

    const first = h.pump.handleDown(event({ path: "slow.md", sha: slow, seq: 105 }));
    await Promise.resolve();
    const second = h.pump.handleDown(event({ path: "fast.md", sha: fast, seq: 107 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.cursors).toEqual([]);

    release();
    await first;
    await second;
    // 105 failed, so nothing at or past it may be acked — 107 included.
    expect(h.cursors).toEqual([]);
  });

  /** m1. Two events can block; clearing one must not release the other. */
  it("keeps holding a second blocked event after the first one clears", async () => {
    const a = await contentHash("a\n");
    const b = await contentHash("b\n");
    const later = await contentHash("later\n");
    const content: Record<string, Uint8Array> = { [later]: utf8("later\n") };
    const h = harness({
      fetchBytes: (sha) => {
        const value = content[sha];
        return Promise.resolve(
          value ? { ok: true as const, value } : { ok: false as const, code: "not_found" },
        );
      },
    });

    await h.pump.handleDown(event({ path: "a.md", sha: a, seq: 105 }));
    await h.pump.handleDown(event({ path: "b.md", sha: b, seq: 110 }));
    content[a] = utf8("a\n");
    await h.pump.handleDown(event({ path: "a.md", sha: a, seq: 105 }));
    await h.pump.handleDown(event({ path: "later.md", sha: later, seq: 111 }));

    // 105 cleared and may be acked; 110 has not, so 111 may not.
    expect(h.cursors).toEqual([105]);
  });

  /**
   * M3. On a live connection the vault never re-sends a blocked event — its
   * per-connection cursor moves on SEND — so the block asks for an
   * authoritative snapshot. Once, not per event.
   */
  it("asks the vault for a snapshot when an event blocks, and only once", async () => {
    const missing = await contentHash("missing\n");
    const h = harness();
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    await h.pump.handleDown(event({ path: "b.md", sha: missing, seq: 6 }));
    expect(h.transport.sent.filter((u) => u.type === "snapshot")).toEqual([{ type: "snapshot" }]);
  });

  /** The failure measured on the live vault was a THROW, not missing content. */
  it("holds the ack for an event whose write throws, not only one whose content is missing", async () => {
    const sha = await contentHash("locked\n");
    const other = await contentHash("other\n");
    const h = harness({
      vault: refusing("locked.md"),
      fetchBytes: fetcherFor({ [sha]: utf8("locked\n"), [other]: utf8("other\n") }),
    });
    await h.pump.handleDown(event({ path: "locked.md", sha, seq: 5 }));
    await h.pump.handleDown(event({ path: "other.md", sha: other, seq: 6 }));
    expect(h.cursors).toEqual([]);
  });

  it("releases every held event once a complete snapshot arrives", async () => {
    const missing = await contentHash("missing\n");
    const later = await contentHash("later\n");
    const h = harness({ fetchBytes: fetcherFor({ [later]: utf8("later\n") }) });
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    await h.pump.handleDown(snapshot([], 40));
    await h.pump.handleDown(event({ path: "later.md", sha: later, seq: 41 }));
    expect(h.cursors).toEqual([40, 41]);
  });

  /**
   * M3's other half: a path the filesystem will never accept. Without a
   * budget it holds `complete` false in every snapshot, so the device never
   * acks again. After three it is reported and passed over.
   */
  it("gives up on a path that fails in three snapshots running, and says which", async () => {
    const sha = await contentHash("locked\n");
    const unavailable: [string, string][] = [];
    const h = harness({
      vault: refusing("locked.md"),
      fetchBytes: fetcherFor({ [sha]: utf8("locked\n") }),
      onUnavailable: (path, reason) => unavailable.push([path, reason]),
    });
    for (const seq of [10, 11, 12]) {
      await h.pump.handleDown(snapshot([{ path: "locked.md", sha }], seq));
      expect(h.cursors).toEqual([]);
    }
    await h.pump.handleDown(snapshot([{ path: "locked.md", sha }], 13));
    expect(h.cursors).toEqual([13]);
    expect(unavailable).toEqual([["locked.md", "refused_locally"]]);
  });
});

/** PL9's wiring through the pump: the ledger and `onKept` must reach both
 * the replay and the snapshot, or the guard is off on the live path. */
describe("Pump — an unpushed edit is handed back, not overwritten", () => {
  it("keeps a held file an inbound put names, and reports it", async () => {
    const theirs = utf8("remote\n");
    const sha = await contentHash("remote\n");
    const kept: string[] = [];
    const h = harness({ fetchBytes: fetcherFor({ [sha]: theirs }), onKept: (p) => kept.push(p) });
    h.vault.files.set("n.md", utf8("local edit\n"));
    h.setLedger({ "n.md": await contentHash("synced\n") });

    await h.pump.handleDown(event({ path: "n.md", sha, seq: 3 }));

    expect(h.vault.text("n.md")).toBe("local edit\n");
    expect(kept).toEqual(["n.md"]);
    expect(h.cursors).toEqual([3]);
  });

  it("keeps a held file a snapshot would overwrite, and reports it", async () => {
    const sha = await contentHash("vault version\n");
    const kept: string[] = [];
    const h = harness({
      fetchBytes: fetcherFor({ [sha]: utf8("vault version\n") }),
      onKept: (p) => kept.push(p),
    });
    h.vault.files.set("n.md", utf8("local edit\n"));
    h.setLedger({ "n.md": await contentHash("synced\n") });

    await h.pump.handleDown({
      type: "snapshot",
      seq: 9,
      more: false,
      files: [{ path: "n.md", sha }],
    });

    expect(h.vault.text("n.md")).toBe("local edit\n");
    expect(kept).toEqual(["n.md"]);
    expect(h.cursors).toEqual([9]);
  });
});
