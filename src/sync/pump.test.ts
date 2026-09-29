// SyncPump's tests.

import { describe, expect, it, type Mock, vi } from "vitest";
import { fixture } from "../testing/wire-fixture.ts";
import type {
  DownApplied,
  DownAppliedBatch,
  DownEvent,
  DownRefused,
  DownSnapshot,
  Up,
  UpDeleteBatch,
  UpPutBatch,
} from "../wire.ts";
import { decodeDown, MAX_FRAME_BYTES, PUT_CHUNK_BYTES } from "../wire.ts";
import type { ApplyDeps, VaultFiles } from "./apply.ts";
import { type BatchLimits, batchLimitsFrom } from "./batch.ts";
import type { Change } from "./derive.ts";
import { contentHash } from "./hash.ts";
import { Pump, type PumpDeps, type SyncTransport } from "./pump.ts";
import { applyResult } from "./results.ts";
import { planRetry } from "./retry.ts";

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
function fakeTransport(): SyncTransport & {
  readonly sent: Up[];
  readonly binary: Uint8Array[];
  /** `noteAck`'s spy as a plain property, so an assertion does not detach a method. */
  readonly acks: Mock;
} {
  const sent: Up[] = [];
  const binary: Uint8Array[] = [];
  const acks = vi.fn();
  return {
    sent,
    binary,
    acks,
    send: (up) => sent.push(up),
    sendBinary: (bytes) => binary.push(bytes),
    noteAck: acks,
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
  over: Partial<DownEvent> & { path: string; sha: string | null; seq: number },
): DownEvent => ({
  type: "event",
  kind: "put",
  from: null,
  at_ms: 0,
  ...over,
});

/**
 * What must be durable before an ack. The pump records per file (`onApplied`) and persists
 * once per flush or snapshot (`persist`), after the cursor moves and before the ack is sent:
 * an ack past unpersisted state is a resume point a crash cannot back up, and a write per
 * file is what capped bulk sync.
 */
describe("Pump — persisting before the ack", () => {
  const ordered = () => {
    const log: string[] = [];
    const h = harness({
      onApplied: (a) => log.push(`applied:${a.length}`),
      onCursor: (seq) => log.push(`cursor:${seq}`),
      persist: () => log.push("persist"),
    });
    const send = h.transport.send.bind(h.transport);
    h.transport.send = (up) => {
      log.push(up.type === "ack" ? `ack:${up.seq}` : up.type);
      send(up);
    };
    return { h, log };
  };

  /** **Proven able to fail** by persisting per `onApplied` again (101 writes), or by
   * persisting after the ack (the ack precedes it in the log). */
  it("persists a 100-event flush once, after the cursor moves and before the ack", async () => {
    const { h, log } = ordered();
    let last: Promise<void> = Promise.resolve();
    for (let seq = 1; seq <= 100; seq++) {
      last = h.pump.handleDown(event({ seq, kind: "delete", path: `gone-${seq}.md`, sha: null }));
    }
    await last;

    expect(log.filter((l) => l === "persist")).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("ack"))).toEqual(["ack:100"]);
    expect(log.slice(-3)).toEqual(["cursor:100", "persist", "ack:100"]);
  });

  it("persists a flush that acks nothing, too", async () => {
    const { h, log } = ordered();
    h.pump.setBatchLimits(null);
    // An event it cannot apply: its content never arrives, so nothing is acked.
    await h.pump.handleDown(event({ seq: 1, path: "n.md", sha: "missing" }));
    expect(log.filter((l) => l === "persist")).toHaveLength(1);
    expect(log.some((l) => l.startsWith("ack"))).toBe(false);
  });

  it("persists a complete snapshot once, before its ack", async () => {
    const { h, log } = ordered();
    await h.pump.handleDown({ type: "snapshot", seq: 9, files: [], more: false });
    expect(log.slice(-3)).toEqual(["cursor:9", "persist", "ack:9"]);
    expect(log.filter((l) => l === "persist")).toHaveLength(1);
  });
});

/**
 * A snapshot is planned and guarded against the ledger as it stood when it began. The shell
 * updates its ledger in place, so a push answer landing mid-snapshot would otherwise change
 * the guard under it: a path the snapshot omits, holding an edit this device just pushed,
 * would suddenly match its ledger entry and look unedited — and be trashed.
 */
describe("Pump — a snapshot's ledger", () => {
  /** **Proven able to fail** by handing `applySnapshot` the live ledger instead of a copy:
   * the edited note is trashed. */
  it("keeps an edited path it omits even when a push answer moves the ledger mid-apply", async () => {
    const edited = "my edit\n";
    const editedSha = await contentHash(edited);
    const vault = fakeVault({ "n.md": edited });
    const live: Record<string, string> = { "n.md": await contentHash("the old version\n") };
    const exists = vault.exists.bind(vault);
    // This device's push of the edit is answered while the snapshot checks the path: the
    // shell writes the pushed sha into the ledger it hands the pump, in place.
    vault.exists = async (path, sensitive) => {
      if (path === "n.md") live["n.md"] = editedSha;
      return exists(path, sensitive);
    };
    const h = harness({ vault, ledger: () => live });

    await h.pump.handleDown({ type: "snapshot", seq: 5, files: [], more: false });

    expect(vault.text("n.md")).toBe(edited);
  });
});

describe("Pump — inbound", () => {
  it("an inbound event is applied and then acked", async () => {
    const sha = await contentHash("hello\n");
    const h = harness({ fetchBytes: fetcherFor({ [sha]: utf8("hello\n") }) });

    await h.pump.handleDown(event({ path: "a.md", sha, seq: 5 }));

    expect(h.vault.text("a.md")).toBe("hello\n");
    expect(h.transport.sent).toEqual([{ type: "ack", seq: 5 }]);
    expect(h.transport.acks).toHaveBeenCalledWith(5);
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
    void h.pump.handleDown(event({ path: "a.md", sha: shaA, seq: 1 }));
    void h.pump.handleDown(event({ path: "b.md", sha: shaB, seq: 2 }));
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

    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: hash });
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

    void h.pump.handleDown({ type: "applied", path: "big.bin", seq: 1, sha: hash });
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
    void h.pump.handleDown(refusal);
    const outcome = await outcomePromise;

    expect(outcome.refused).toEqual(refusal);
    expect(h.refusals).toEqual([refusal]);
  });

  /**
   * An `applied` reply must NOT advance the persisted cursor by itself — the
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
    void h.pump.handleDown(applied);
    await donePromise;

    expect(h.cursors).toEqual([]);
  });

  it("the cursor advances once the vault's own echo of that write actually arrives", async () => {
    const content = utf8("x\n");
    const hash = await contentHash("x\n");
    const h = harness({ fetchBytes: fetcherFor({ [hash]: content }) });
    const donePromise = h.pump.push(put("a.md", content, hash));
    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 4821, sha: hash });
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

    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: hashA });
    await doneA;
    expect(h.transport.sent).toHaveLength(2);
    expect((h.transport.sent[1] as { path: string }).path).toBe("b.md");

    void h.pump.handleDown({ type: "applied", path: "b.md", seq: 2, sha: hashB });
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

    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 9, sha: hash });
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
    const send = h.transport.send.bind(h.transport);
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

/**
 * Bulk-ingest design BI5: against a vault that advertised batch limits in `ready`, consecutive
 * small puts at the head of the queue leave as one `put_batch`, and one `applied_batch`
 * settles them all by path. Still single-flight: batching changes the unit, not the
 * concurrency.
 */
describe("Pump — put_batch", () => {
  const LIMITS = { maxOps: 100, maxBytes: 4 * 1024 * 1024, maxDeleteOps: 100 };
  const put = (path: string, size = 3): Change => ({
    op: "put",
    path,
    base: null,
    content: new Uint8Array(size).fill(path.length),
    hash: `sha-${path}`,
  });
  const batching = () => {
    const h = harness();
    h.pump.setBatchLimits(LIMITS);
    return h;
  };
  const batches = (h: ReturnType<typeof harness>): UpPutBatch[] =>
    h.transport.sent.filter((u): u is UpPutBatch => u.type === "put_batch");
  const answer = (h: ReturnType<typeof harness>, down: Omit<DownAppliedBatch, "type">) =>
    h.pump.handleDown({ type: "applied_batch", ...down });

  /**
   * One header, then exactly one binary frame per entry, in order, with an empty file as a
   * zero-length frame: the vault correlates frames with entries by position. **Proven able to
   * fail** by skipping the frame of an empty entry: the frame lengths read `[3, 5]`, and every
   * frame after the empty file would belong to the wrong entry.
   */
  it("sends consecutive small puts as one put_batch, then one binary frame each", () => {
    const h = batching();
    const changes = [put("a.md", 3), put("b.md", 0), put("c.md", 5)];
    void h.pump.pushAll(changes);

    expect(h.transport.sent).toEqual([
      {
        type: "put_batch",
        puts: [
          { path: "a.md", base_sha: null, sha: "sha-a.md", bytes: 3 },
          { path: "b.md", base_sha: null, sha: "sha-b.md", bytes: 0 },
          { path: "c.md", base_sha: null, sha: "sha-c.md", bytes: 5 },
        ],
      },
    ]);
    expect(h.transport.binary.map((b) => b.byteLength)).toEqual([3, 0, 5]);
    expect(h.transport.binary).toEqual(changes.map((c) => (c.op === "put" ? c.content : null)));
  });

  it("settles every entry by path from one applied_batch, and a refused one reaches onRefused and retry.ts", async () => {
    const h = batching();
    const [a, b, c] = h.pump.pushAll([put("a.md"), put("b.md"), put("c.md")]);
    const refused = { path: "b.md", reason: "stale", current_sha: "cur" };
    // Out of order on purpose: the answer is keyed by path, never by position.
    void answer(h, {
      applied: [
        { path: "c.md", seq: 12, sha: "sha-c.md" },
        { path: "a.md", seq: null, sha: "sha-a.md" },
      ],
      refused: [refused],
    });

    await expect(a).resolves.toMatchObject({ hashes: { "a.md": "sha-a.md" }, refused: null });
    await expect(c).resolves.toMatchObject({ hashes: { "c.md": "sha-c.md" }, refused: null });
    const outcomeB = await (b as Promise<{ refused: DownRefused | null }>);
    expect(outcomeB.refused).toEqual({ type: "refused", ...refused });
    expect(h.refusals).toEqual([{ type: "refused", ...refused }]);
    // What `main.ts` does with it: a current sha to reconcile against, so it is redirtied.
    expect(planRetry(h.refusals).redirty).toEqual([{ path: "b.md", currentSha: "cur" }]);
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  it("sends a put larger than one chunk alone, between batches", async () => {
    const h = batching();
    const big = put("big.png", 300 * 1024);
    const done = h.pump.pushAll([put("a.md"), put("b.md"), big, put("c.md"), put("d.md")]);

    expect(h.transport.sent.map((u) => u.type)).toEqual(["put_batch"]);
    void answer(h, {
      applied: [
        { path: "a.md", seq: 1, sha: "sha-a.md" },
        { path: "b.md", seq: 2, sha: "sha-b.md" },
      ],
      refused: [],
    });
    await Promise.all(done.slice(0, 2));
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put_batch", "put"]);
    // Today's chunked put: more than one frame, because it is more than one chunk.
    expect(h.transport.binary.length).toBe(2 + Math.ceil((300 * 1024) / PUT_CHUNK_BYTES));

    void h.pump.handleDown({ type: "applied", path: "big.png", seq: 3, sha: "sha-big.png" });
    await done[2];
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put_batch", "put", "put_batch"]);
    expect(batches(h)[1]?.puts.map((p) => p.path)).toEqual(["c.md", "d.md"]);
  });

  it("ends a batch at a delete or a rename, which go as their own frames", async () => {
    const h = batching();
    const done = h.pump.pushAll([
      put("a.md"),
      put("b.md"),
      { op: "delete", path: "x.md", base: "bx" },
      { op: "rename", path: "z.md", from: "y.md", base: "by" },
      put("c.md"),
    ]);
    void answer(h, {
      applied: [
        { path: "a.md", seq: 1, sha: "sha-a.md" },
        { path: "b.md", seq: 2, sha: "sha-b.md" },
      ],
      refused: [],
    });
    await Promise.all(done.slice(0, 2));
    void h.pump.handleDown({ type: "applied", path: "x.md", seq: 3, sha: "" });
    await done[2];
    void h.pump.handleDown({ type: "applied", path: "z.md", seq: 4, sha: "sz" });
    await done[3];

    // A lone put after them is a plain put, not a batch of one.
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put_batch", "delete", "rename", "put"]);
  });

  /** A vault without the frame drops it in silence: sending one would stall the queue for
   * good. **Proven able to fail** by defaulting the limits to the wire's constants. */
  it("sends every put singly without limits", async () => {
    const h = harness();
    const done = h.pump.pushAll([put("a.md"), put("b.md")]);
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put"]);
    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: "sha-a.md" });
    await done[0];
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put", "put"]);
  });

  it("rejects an entry the answer does not name, rather than leaving it pending", async () => {
    const h = batching();
    const [a, b] = h.pump.pushAll([put("a.md"), put("b.md")]);
    void answer(h, { applied: [{ path: "a.md", seq: 1, sha: "sha-a.md" }], refused: [] });

    await expect(a).resolves.toMatchObject({ hashes: { "a.md": "sha-a.md" } });
    await expect(b).rejects.toThrow(/b\.md/);
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  it("ignores a single answer while a batch is in flight, and a batch answer while none is", async () => {
    const h = batching();
    const [a] = h.pump.pushAll([put("a.md")]); // alone: a plain put
    void answer(h, { applied: [{ path: "a.md", seq: 1, sha: "wrong" }], refused: [] });
    expect(h.pump.hasOutstanding()).toBe(true);
    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: "sha-a.md" });
    await a;

    const [b, c] = h.pump.pushAll([put("b.md"), put("c.md")]);
    void h.pump.handleDown({ type: "applied", path: "b.md", seq: 2, sha: "wrong" });
    expect(h.pump.hasOutstanding()).toBe(true);
    void answer(h, {
      applied: [
        { path: "b.md", seq: 2, sha: "sha-b.md" },
        { path: "c.md", seq: 3, sha: "sha-c.md" },
      ],
      refused: [],
    });
    await expect(b).resolves.toMatchObject({ hashes: { "b.md": "sha-b.md" } });
    await c;
  });

  /** §11 for a batch: a drop leaves every entry at the head of the queue, and `resume()`
   * sends them all again — re-planned against whatever limits the new connection has. */
  it("a drop plus resume() re-sends the whole in-flight batch", async () => {
    const h = batching();
    const done = h.pump.pushAll([put("a.md"), put("b.md"), put("c.md")]);
    expect(batches(h)).toHaveLength(1);

    h.pump.resume();
    expect(batches(h)).toHaveLength(2);
    expect(batches(h)[1]).toEqual(batches(h)[0]);
    expect(h.transport.binary).toHaveLength(6);

    // A reconnect to a vault that no longer batches: the same heads, one at a time.
    h.pump.setBatchLimits(null);
    h.pump.resume();
    expect(h.transport.sent.map((u) => u.type)).toEqual(["put_batch", "put_batch", "put"]);
    for (const [i, path] of ["a.md", "b.md", "c.md"].entries()) {
      void h.pump.handleDown({ type: "applied", path, seq: i + 1, sha: `sha-${path}` });
      await done[i];
    }
  });

  it("abandon() rejects every batched entry", async () => {
    const h = batching();
    const done = h.pump.pushAll([put("a.md"), put("b.md"), put("c.md")]);
    h.pump.abandon();
    for (const d of done) await expect(d).rejects.toThrow();
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  it("a batch whose send throws rejects every entry and leaves nothing to re-send", async () => {
    const h = batching();
    const send = h.transport.send.bind(h.transport);
    let ready = false;
    h.transport.send = (up) => {
      if (!ready) throw new Error("cannot send before the sync handshake completes");
      send(up);
    };
    const done = h.pump.pushAll([put("a.md"), put("b.md")]);
    for (const d of done) await expect(d).rejects.toThrow();
    ready = true;
    h.pump.resume();
    expect(h.transport.sent).toEqual([]);
  });

  it("pushAll throws for an oversize change before queuing or sending any", () => {
    const h = batching();
    const huge = put("huge.bin", MAX_FRAME_BYTES + 1);
    expect(() => h.pump.pushAll([put("a.md"), huge, put("b.md")])).toThrow(/MAX_FRAME_BYTES/);
    expect(h.transport.sent).toEqual([]);
    expect(h.pump.hasOutstanding()).toBe(false);
  });
});

/**
 * Consecutive deletes at the head of the queue leave as one `delete_batch`, against a vault
 * whose `ready` advertised `max_delete_batch_ops`, and one `applied_batch` settles each by
 * path exactly as a single delete's answer would. A put or a rename ends the run.
 */
describe("Pump — delete_batch", () => {
  const LIMITS = { maxOps: 100, maxBytes: 4 * 1024 * 1024, maxDeleteOps: 100 };
  const del = (path: string): Change => ({ op: "delete", path, base: `base-${path}` });
  const put = (path: string): Change => ({
    op: "put",
    path,
    base: null,
    content: new Uint8Array(3),
    hash: `sha-${path}`,
  });
  const batching = (limits: BatchLimits | null = LIMITS) => {
    const h = harness();
    h.pump.setBatchLimits(limits);
    return h;
  };
  const deleteBatches = (h: ReturnType<typeof harness>): UpDeleteBatch[] =>
    h.transport.sent.filter((u): u is UpDeleteBatch => u.type === "delete_batch");
  const types = (h: ReturnType<typeof harness>) => h.transport.sent.map((u) => u.type);
  /** Every path of the batch in flight applied, as a deletion that wrote one event each. */
  const applyAll = (h: ReturnType<typeof harness>, paths: readonly string[], seq0 = 1) =>
    h.pump.handleDown({
      type: "applied_batch",
      applied: paths.map((path, i) => ({ path, seq: seq0 + i, sha: "" })),
      refused: [],
    });

  it("sends a run of deletes as one delete_batch, header only, each entry as a delete carries it", () => {
    const h = batching();
    void h.pump.pushAll([del("a.md"), del("b.md"), del("c.md")]);
    expect(h.transport.sent).toEqual([
      {
        type: "delete_batch",
        deletes: [
          { path: "a.md", base_sha: "base-a.md" },
          { path: "b.md", base_sha: "base-b.md" },
          { path: "c.md", base_sha: "base-c.md" },
        ],
      },
    ]);
    expect(h.transport.binary).toEqual([]);
  });

  /** **Proven able to fail** by ignoring `maxDeleteOps` in the delete run: one batch of 250. */
  it("never puts more entries in one batch than the vault advertised", async () => {
    const h = batching({ ...LIMITS, maxDeleteOps: 100 });
    const paths = Array.from({ length: 250 }, (_, i) => `n${i}.md`);
    const done = h.pump.pushAll(paths.map(del));
    for (let sent = 0; sent < 3; sent++) {
      const batch = deleteBatches(h)[sent];
      expect(batch).toBeDefined();
      void applyAll(h, batch?.deletes.map((d) => d.path) ?? [], sent * 100);
    }
    await Promise.all(done);
    expect(deleteBatches(h).map((b) => b.deletes.length)).toEqual([100, 100, 50]);
    expect(types(h)).toEqual(["delete_batch", "delete_batch", "delete_batch"]);
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  /** A delete or rename between puts may be what gives the next put its meaning, so a put or a
   * rename ends a run. **Proven able to fail** by letting any non-rename ride a delete run. */
  it("ends a run at a put or a rename, which go as their own frames", async () => {
    const h = batching();
    const done = h.pump.pushAll([
      del("a.md"),
      del("b.md"),
      put("c.md"),
      del("d.md"),
      del("e.md"),
      { op: "rename", path: "z.md", from: "y.md", base: "by" },
      del("f.md"),
    ]);
    void applyAll(h, ["a.md", "b.md"]);
    await Promise.all(done.slice(0, 2));
    void h.pump.handleDown({ type: "applied", path: "c.md", seq: 3, sha: "sha-c.md" });
    await done[2];
    void applyAll(h, ["d.md", "e.md"], 4);
    await Promise.all(done.slice(3, 5));
    void h.pump.handleDown({ type: "applied", path: "z.md", seq: 6, sha: "sz" });
    await done[5];
    void h.pump.handleDown({ type: "applied", path: "f.md", seq: 7, sha: "" });
    await done[6];

    // A lone delete at the tail is a plain delete, not a batch of one.
    expect(types(h)).toEqual(["delete_batch", "put", "delete_batch", "rename", "delete"]);
    expect(deleteBatches(h).map((b) => b.deletes.map((d) => d.path))).toEqual([
      ["a.md", "b.md"],
      ["d.md", "e.md"],
    ]);
  });

  /** The vault closes a `delete_batch` naming one path twice, for good. */
  it("never names one path twice in a batch", async () => {
    const h = batching();
    const done = h.pump.pushAll([del("a.md"), del("b.md"), del("a.md")]);
    expect(deleteBatches(h)[0]?.deletes.map((d) => d.path)).toEqual(["a.md", "b.md"]);
    void applyAll(h, ["a.md", "b.md"]);
    await Promise.all(done.slice(0, 2));
    expect(h.transport.sent[h.transport.sent.length - 1]).toEqual({
      type: "delete",
      path: "a.md",
      base_sha: "base-a.md",
    });
  });

  /** An older vault drops the unknown frame in silence, and the pump would wait for good.
   * **Proven able to fail** by reading `max_delete_batch_ops`'s absence as the wire's cap, or
   * as `max_batch_ops` in the decoder. */
  it("sends no delete_batch when ready lacks max_delete_batch_ops", async () => {
    // Decoded from the wire, as `main.ts` gets it: the fixture has no delete field at all.
    const ready = decodeDown(fixture("vault-sync/down.ready_put_only.json"));
    if (ready.type !== "ready") throw new Error("the fixture is a ready frame");
    const h = batching(batchLimitsFrom(ready));
    const done = h.pump.pushAll([del("a.md"), del("b.md")]);
    expect(types(h)).toEqual(["delete"]);
    void h.pump.handleDown({ type: "applied", path: "a.md", seq: 1, sha: "" });
    await done[0];
    expect(types(h)).toEqual(["delete", "delete"]);
    void h.pump.handleDown({ type: "applied", path: "b.md", seq: 2, sha: "" });
    await done[1];
  });

  /**
   * Each entry's answer settles its own change, exactly as a single delete's would: applied
   * (one event), applied with a null seq (already gone), and refused over a stale base — an
   * edit beat the delete — which reaches `onRefused` and `retry.ts` with its current sha.
   */
  it("settles each delete by path: applied, already gone, refused over a stale base", async () => {
    const h = batching();
    const changes = [del("a.md"), del("b.md"), del("c.md")];
    const [a, b, c] = h.pump.pushAll(changes);
    const stale = {
      path: "c.md",
      reason: "that path changed since you last saw it",
      current_sha: "cur-c",
    };
    void h.pump.handleDown({
      type: "applied_batch",
      // Out of order on purpose: the answer is keyed by path, never by position.
      applied: [
        { path: "b.md", seq: null, sha: "" },
        { path: "a.md", seq: 41, sha: "" },
      ],
      refused: [stale],
    });

    await expect(a).resolves.toEqual({ hashes: {}, forget: ["a.md"], refused: null, pull: [] });
    await expect(b).resolves.toEqual({ hashes: {}, forget: ["b.md"], refused: null, pull: [] });
    // The same outcome a single `refused` answer to a single `delete` gives.
    await expect(c).resolves.toEqual(
      applyResult(changes[2] as Change, { type: "refused", ...stale }),
    );
    expect(h.refusals).toEqual([{ type: "refused", ...stale }]);
    expect(planRetry(h.refusals).redirty).toEqual([{ path: "c.md", currentSha: "cur-c" }]);
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  /**
   * §11 for a delete batch: a drop leaves every entry at the head of the queue, and `resume()`
   * sends the same batch again. That is safe because a delete of a path already gone is
   * applied, not refused — the vault may have applied the first send before the drop.
   */
  it("a drop mid-batch plus resume() re-sends it, and gone paths settle as applied", async () => {
    const h = batching();
    const done = h.pump.pushAll([del("a.md"), del("b.md"), del("c.md")]);
    expect(deleteBatches(h)).toHaveLength(1);

    h.pump.connectionLost();
    h.pump.resume();
    expect(deleteBatches(h)).toHaveLength(2);
    expect(deleteBatches(h)[1]).toEqual(deleteBatches(h)[0]);

    // The first send landed before the drop: every path is gone now.
    void h.pump.handleDown({
      type: "applied_batch",
      applied: ["a.md", "b.md", "c.md"].map((path) => ({ path, seq: null, sha: "" })),
      refused: [],
    });
    const outcomes = await Promise.all(done);
    expect(outcomes.map((o) => o.forget)).toEqual([["a.md"], ["b.md"], ["c.md"]]);
    expect(h.pump.hasOutstanding()).toBe(false);
  });

  /** `planBatch` never mixes kinds; if a batch ever did, an entry dropped from the frame
   * would wait for an answer that never names it. **Proven able to fail** by removing the
   * check: the put is dropped and a two-entry `delete_batch` goes out. */
  it("refuses to send a batch of mixed kinds rather than drop an entry", () => {
    const h = batching();
    const inside = h.pump as unknown as { sendBatch(changes: readonly Change[]): void };
    expect(() => inside.sendBatch([del("a.md"), put("b.md"), del("c.md")])).toThrow(/put/);
    expect(() => inside.sendBatch([put("a.md"), del("b.md")])).toThrow(/delete/);
    expect(h.transport.sent).toEqual([]);
  });

  it("a reconnect to a vault without delete_batch re-sends the in-flight batch as single deletes", async () => {
    const h = batching();
    const done = h.pump.pushAll([del("a.md"), del("b.md")]);
    h.pump.connectionLost();
    h.pump.setBatchLimits({ ...LIMITS, maxDeleteOps: 0 });
    h.pump.resume();
    expect(types(h)).toEqual(["delete_batch", "delete"]);
    // A stray batch answer now names nothing in flight.
    void applyAll(h, ["a.md", "b.md"]);
    expect(h.pump.hasOutstanding()).toBe(true);
    for (const [i, path] of ["a.md", "b.md"].entries()) {
      void h.pump.handleDown({ type: "applied", path, seq: i + 1, sha: "" });
      await done[i];
    }
    expect(types(h)).toEqual(["delete_batch", "delete", "delete"]);
  });
});

/**
 * Under the ack rule a blocked seq holds the cursor until a snapshot completes, and the
 * vault closes a connection with too many events unacknowledged. So a snapshot request
 * must not die with the connection it was sent on: one that stayed "outstanding" after
 * its socket went would stop every later block from asking again.
 */
describe("Pump — a resync across a reconnect", () => {
  const snapshot = (
    files: Array<{ path: string; sha: string }>,
    seq: number,
    more = false,
  ): DownSnapshot => ({ type: "snapshot", seq, files, more });
  const snapshotRequests = (h: ReturnType<typeof harness>) =>
    h.transport.sent.filter((u) => u.type === "snapshot").length;

  it("asks again on the next connection for a request lost with its socket", async () => {
    const missing = await contentHash("missing\n");
    const h = harness();
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    expect(snapshotRequests(h)).toBe(1);

    // The socket goes before the vault answers; the next one becomes ready.
    h.pump.connectionLost();
    h.pump.resume();
    expect(snapshotRequests(h)).toBe(2);

    // And only once on that connection, however many more events block.
    await h.pump.handleDown(event({ path: "b.md", sha: missing, seq: 6 }));
    expect(snapshotRequests(h)).toBe(2);
  });

  it("releases a blocked seq once a snapshot completes on the next connection", async () => {
    const missing = await contentHash("missing\n");
    const later = await contentHash("later\n");
    const h = harness({ fetchBytes: fetcherFor({ [later]: utf8("later\n") }) });
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    await h.pump.handleDown(event({ path: "later.md", sha: later, seq: 6 }));
    expect(h.cursors).toEqual([]); // 5 is blocked, so 6 may not be acked

    h.pump.connectionLost();
    h.pump.resume();
    await h.pump.handleDown(snapshot([{ path: "later.md", sha: later }], 40));

    expect(h.cursors).toEqual([40]);
    expect(h.transport.sent).toContainEqual({ type: "ack", seq: 40 });
    await h.pump.handleDown(event({ path: "n.md", sha: later, seq: 41 }));
    expect(h.cursors).toEqual([40, 41]);
  });

  it("does not ask on reconnect when nothing is blocked", async () => {
    const h = harness();
    h.pump.connectionLost();
    h.pump.resume();
    expect(snapshotRequests(h)).toBe(0);
  });

  it("drops a half-received snapshot with the connection, so a later page cannot apply alone", async () => {
    const sha = await contentHash("kept\n");
    const h = harness();
    h.vault.files.set("kept.md", utf8("kept\n"));
    h.vault.files.set("gone.md", utf8("gone\n"));
    h.setLedger({ "kept.md": sha, "gone.md": await contentHash("gone\n") });

    await h.pump.handleDown(snapshot([{ path: "gone.md", sha: "0".repeat(64) }], 50, true));
    h.pump.connectionLost();
    // The next connection's snapshot, same seq, starts over: its last page alone is the list.
    await h.pump.handleDown(snapshot([{ path: "kept.md", sha }], 50, false));
    expect(h.vault.files.has("kept.md")).toBe(true);
    expect(h.vault.files.has("gone.md")).toBe(false); // trashed: the new list omits it
    expect(h.cursors).toEqual([50]);
  });

  it("ignores a snapshot page from a connection that went while it waited its turn", async () => {
    const slow = await contentHash("slow\n");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      fetchBytes: async () => {
        await gate;
        return { ok: false as const, code: "disconnected" };
      },
    });
    h.vault.files.set("mine.md", utf8("mine\n"));
    h.setLedger({ "mine.md": await contentHash("mine\n") });

    // A flush is waiting on a fetch; the last page of a snapshot queues behind it.
    const flushing = h.pump.handleDown(event({ path: "slow.md", sha: slow, seq: 3 }));
    const page = h.pump.handleDown(snapshot([], 60, false));
    h.pump.connectionLost();
    release();
    await flushing;
    await page;

    // Applied, that empty list would have trashed `mine.md` and acked 60.
    expect(h.vault.files.has("mine.md")).toBe(true);
    expect(h.cursors).toEqual([]);
  });

  it("passes fetchMany through, so a snapshot's notes arrive in one want", async () => {
    const a = utf8("a\n");
    const b = utf8("b\n");
    const shaA = await contentHash("a\n");
    const shaB = await contentHash("b\n");
    const many: string[][] = [];
    const h = harness({
      fetchMany: (shas) => {
        many.push([...shas]);
        const have: Record<string, Uint8Array> = { [shaA]: a, [shaB]: b };
        return Promise.resolve(
          new Map(
            shas.map((s) => [
              s,
              have[s] ? { ok: true as const, value: have[s] } : { ok: false as const, code: "x" },
            ]),
          ),
        );
      },
    });
    await h.pump.handleDown(
      snapshot(
        [
          { path: "a.md", sha: shaA },
          { path: "b.md", sha: shaB },
        ],
        70,
      ),
    );
    expect(many).toEqual([[shaA, shaB]]);
    expect(h.cursors).toEqual([70]);
  });
});

describe("Pump — the resync guards, one at a time", () => {
  const snapshot = (files: Array<{ path: string; sha: string }>, seq: number): DownSnapshot => ({
    type: "snapshot",
    seq,
    files,
    more: false,
  });
  const snapshotRequests = (sent: readonly Up[]) => sent.filter((u) => u.type === "snapshot");

  /**
   * A snapshot from the old connection that finishes applying AFTER the next connection
   * asked again must not clear that newer request: it did not answer it. If it did, the
   * next block would send a second request on a connection already waiting for one.
   */
  it("an old connection's snapshot finishing late leaves the new connection's request standing", async () => {
    const missing = await contentHash("missing\n");
    const pending = await contentHash("pending\n");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      fetchBytes: async (sha) => {
        if (sha === pending) await gate;
        return { ok: false as const, code: "disconnected" };
      },
    });
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    expect(snapshotRequests(h.transport.sent)).toHaveLength(1);

    // The old connection's answer starts applying and waits on a fetch.
    const applying = h.pump.handleDown(snapshot([{ path: "p.md", sha: pending }], 40));
    await new Promise((r) => setTimeout(r, 10));
    h.pump.connectionLost();
    h.pump.resume();
    const onNew = h.transport.sent.length - 1;
    expect(snapshotRequests(h.transport.sent)).toHaveLength(2);

    release();
    await applying;
    await h.pump.handleDown(event({ path: "b.md", sha: missing, seq: 6 }));
    // Exactly one request on the new connection.
    expect(snapshotRequests(h.transport.sent.slice(onNew))).toHaveLength(1);
  });

  /**
   * A request whose send throws never reached the vault, so it must not count as asked:
   * marking it first would leave the block unasked about for the rest of the connection.
   */
  it("a request whose send throws is not marked asked, so the next chance asks", async () => {
    const missing = await contentHash("missing\n");
    const transport = fakeTransport();
    let failOnce = true;
    const h = harness({
      transport: {
        ...transport,
        send: (up) => {
          if (up.type === "snapshot" && failOnce) {
            failOnce = false;
            throw new Error("cannot send before the sync handshake completes");
          }
          transport.send(up);
        },
      },
    });
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    expect(snapshotRequests(transport.sent)).toHaveLength(0);
    await h.pump.handleDown(event({ path: "b.md", sha: missing, seq: 6 }));
    expect(snapshotRequests(transport.sent)).toHaveLength(1);
  });

  /** The complement of dropping a stale page: a snapshot already applying when the socket
   * went was whole, so it completes and acks on the next connection. */
  it("a snapshot already applying when the connection went still completes and acks", async () => {
    const missing = await contentHash("missing\n");
    const body = utf8("n\n");
    const sha = await contentHash("n\n");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      fetchBytes: async (s) => {
        if (s !== sha) return { ok: false as const, code: "not_found" };
        await gate;
        return { ok: true as const, value: body };
      },
    });
    await h.pump.handleDown(event({ path: "a.md", sha: missing, seq: 5 }));
    const applying = h.pump.handleDown(snapshot([{ path: "n.md", sha }], 40));
    await new Promise((r) => setTimeout(r, 10));
    h.pump.connectionLost();
    h.pump.resume();
    release();
    await applying;
    expect(h.vault.text("n.md")).toBe("n\n");
    expect(h.cursors).toEqual([40]);
    expect(h.transport.sent).toContainEqual({ type: "ack", seq: 40 });
  });
});
