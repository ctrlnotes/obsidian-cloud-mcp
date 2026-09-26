// Events down, content up (write-surface design §8.1–§8.3, §8.4) — the layer that turns a
// connected `SyncSocket` into applied files and acknowledged, retried pushes.
// Greenfield, like `SyncSocket`: nothing from an earlier prototype ports here, because its wire had a batch
// (`applyResults` correlating `results[i]` to `sent[i]` by index) and a separate HTTP
// content channel that this protocol does not have.
//
// **One frame out, one answer back, no index to get wrong** (`results.ts`'s own doc
// comment, restated here because it drives this file's whole outbound shape): our wire
// answers exactly one `Up::Put`/`Delete`/`Rename` with exactly one `Down::Applied` or
// `Down::Refused`, in order. So sending is single-flight — a change queues behind whatever
// is already in flight rather than racing it, because there would be no way to tell two
// outstanding replies apart.
//
// **A `put_batch` is still one frame and one answer** (bulk-ingest design BI5): consecutive
// small puts at the head of the queue go together (`batch.ts`'s `planBatch`), and one
// `Down::AppliedBatch` answers them all, keyed by their distinct paths.
//
// **§11: content addressing makes a retry a no-op.** A change is never removed from the
// outbound queue until its own reply names it done — a connection dropping mid-upload
// leaves the SAME `Change` at the head of the queue, so the only thing a reconnect can do
// is send it again, never invent a second copy of it.
//
// **Acking is batched.** `Down::Event` frames arriving back to back are applied together
// and end in exactly one `Up::Ack` for the batch's highest seq, not one frame per event —
// acking is what makes an event durable for this device (§8.3), and a socket write per
// event is a socket write this protocol does not need.

import type {
  Down,
  DownApplied,
  DownAppliedBatch,
  DownEvent,
  DownRefused,
  DownSnapshot,
  SnapshotEntry,
  Up,
} from "../wire.ts";
import { MAX_FRAME_BYTES, PUT_CHUNK_BYTES } from "../wire.ts";
import {
  type Applied,
  type ApplyDeps,
  applyReplay,
  applySnapshot,
  type VaultFiles,
} from "./apply.ts";
import { type BatchLimits, planBatch } from "./batch.ts";
import type { Change, DeriveOptions } from "./derive.ts";
import { applyResult, type ResultOutcome } from "./results.ts";

/** The slice of `SyncSocket` this module drives — narrow, the same reasoning as
 * `device.ts`'s `SecretStorageHost`: a test hands this a plain object, never a real socket. */
export interface SyncTransport {
  send(up: Up): void;
  sendBinary(bytes: Uint8Array): void;
  /** Told once a batch of inbound events (or a snapshot) has been fully applied, so the
   * NEXT reconnect resumes from here rather than from a seq merely seen (`socket.ts`'s header). */
  noteAck(seq: number): void;
}

export interface PumpDeps {
  readonly transport: SyncTransport;
  readonly vault: VaultFiles;
  readonly fetchBytes: ApplyDeps["fetchBytes"];
  /** The CURRENT ledger, read fresh every time — a snapshot arriving mid-session must diff
   * against whatever this device believes right now, not a copy taken at construction. */
  readonly ledger: () => Readonly<Record<string, string>>;
  /** Every path this batch (or snapshot) actually touched — `state.ts`'s ledger update. */
  readonly onApplied: (applied: readonly Applied[]) => void;
  /**
   * The server will never send this path's content (O3). Passed straight
   * through to `ApplyDeps`, which is the only place the fact is known.
   */
  readonly onUnavailable?: ApplyDeps["onUnavailable"];
  /** An inbound change left a file alone because it holds an unpushed edit —
   * `ApplyDeps.onKept`. The caller makes sure that edit is uploaded. */
  readonly onKept?: ApplyDeps["onKept"];
  /** This device's own record of "the highest server change applied" (`SyncState.cursor`),
   * advanced by an inbound batch's top seq, a snapshot's seq, or this device's OWN push
   * landing (`Down::Applied.seq`) — see `handleDown`'s `applied` branch for why the last one
   * counts too: the vault will not send this device's own write back as a further event. */
  readonly onCursor: (seq: number) => void;
  /** A push came back refused — `retry.ts` is what classifies it; this file only reports it. */
  readonly onRefused?: (refused: DownRefused) => void;
  readonly attachments?: DeriveOptions["attachments"];
}

function* chunk(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  if (bytes.byteLength === 0) {
    yield bytes; // An empty file still opens and closes an upload — `Upload::begin` accepts
    // `bytes: 0` and completes with zero pushes, but this plugin always sends at least one
    // binary frame per `put` rather than relying on that edge case matching on both ends.
    return;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

interface QueuedPush {
  readonly change: Change;
  readonly resolve: (outcome: ResultOutcome) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * The outbound queue and the inbound apply-and-ack loop for one connected socket.
 *
 * **Owns no socket.** `main.ts` is what feeds this class's `handleDown` every
 * `Down` frame `SyncSocket.onFrame` delivers, and calls `push` for every `Change`
 * `derive.ts` produces. Splitting it this way is what makes it testable with a bare object
 * standing in for the transport, the same shape as every other module in `sync/`.
 */
export class Pump {
  private readonly eventQueue: DownEvent[] = [];
  private flushScheduled = false;
  /**
   * Every seq this device wanted to apply and could not, carried ACROSS
   * batches. The cursor may never be acked at or past the lowest.
   *
   * **`applyReplay`'s own boundary lives inside one call, and that is not
   * enough.** A later batch that applies cleanly reports its own highest seq,
   * and acking it claims every earlier event durable — including one that
   * failed. The vault resumes from the acked cursor and never offers it
   * again. Measured on the live vault 2026-09-22: a rename that could not be
   * applied at 105 was acked past when an unrelated event arrived at 107.
   *
   * **A set, not one slot**: two events can block, and a later pass can clear
   * one of them. **What clears one**: a flush that carries that seq and
   * applies it, or a complete snapshot, which is authoritative and makes
   * every earlier event moot. **Neither happens on its own on a live
   * connection** — the vault's per-connection cursor moves on SEND
   * (`drain` in `apps/vault/src/http/routes/sync.rs`), so a blocked event is
   * never re-sent until a reconnect — which is why a block asks for a
   * snapshot (`requestResync`).
   */
  private readonly outstanding = new Set<number>();
  /** A `snapshot` request is out and not yet answered — at most one at a time. */
  private resyncRequested = false;
  /**
   * How many snapshots running a path has thrown in. Past
   * {@link Pump.MAX_LOCAL_FAILURES} it is given up on and reported, because a
   * path the filesystem will never accept would otherwise hold this device's
   * cursor for the rest of its life.
   */
  private readonly localFailures = new Map<string, number>();
  private static readonly MAX_LOCAL_FAILURES = 3;
  /** The in-flight (or most recently settled) batch flush. Every `event` frame that lands
   * inside one batch window gets back the SAME promise — see `scheduleFlush` — which is
   * what lets a caller await "my event has been applied and acked" without collapsing the
   * batching itself into one flush per call. */
  private flushDone: Promise<void> = Promise.resolve();

  private readonly pending: QueuedPush[] = [];
  /** How many entries at the head of `pending` the one outstanding frame carries: 0 when
   * nothing is in flight, 1 for a single frame, n ≥ 2 for a `put_batch` (`planBatch` never
   * plans a batch of one). */
  private inFlight = 0;
  /** What this connection's vault accepts in one `put_batch`, or `null` for no batching. Set
   * from each `ready`, because a reconnect may land on a vault with different limits. */
  private limits: BatchLimits | null = null;

  constructor(private readonly deps: PumpDeps) {}

  /**
   * Route one `Down` frame that arrived after the handshake. `challenge`/`ready`/`closing`
   * never reach here — those are `SyncSocket`'s own business.
   *
   * The returned promise resolves once this frame's own effect — the batch it joined, or
   * the snapshot it was — has actually been applied and acked. `main.ts` need not await it
   * per frame (doing so between every `event` would defeat batching, since nothing would
   * ever be waiting alongside it) — it exists mainly so a test can wait for a known point
   * without guessing how many microtask turns that takes.
   */
  handleDown(down: Down): Promise<void> {
    switch (down.type) {
      case "event":
        this.eventQueue.push(down);
        this.scheduleFlush();
        return this.flushDone;
      case "snapshot":
        // Through the same chain as event flushes, so a snapshot never applies
        // beside a flush that is still writing — `scheduleFlush` says why
        // overlap is unsafe.
        this.flushDone = this.flushDone
          .then(() => this.applySnapshotFrame(down))
          .catch((e: unknown) => {
            console.warn("Ctrl Notes: applying a snapshot failed", e);
          });
        return this.flushDone;
      case "applied":
      case "refused":
        this.settlePush(down);
        return Promise.resolve();
      case "applied_batch":
        this.settleBatch(down);
        return Promise.resolve();
      default:
        return Promise.resolve(); // challenge / ready / closing: not this file's concern.
    }
  }

  /** {@link pushAll} for one change. */
  push(change: Change): Promise<ResultOutcome> {
    return this.pushAll([change])[0] as Promise<ResultOutcome>;
  }

  /**
   * Queue local changes and send, resolving each once the vault has answered it — one promise
   * per change, in order. Every change is queued BEFORE anything is sent, so small puts leave
   * as one `put_batch` rather than a lone `put` followed by a batch of the rest (BI5).
   *
   * **Single-flight, queued.** Changes queue behind whatever is in flight — see this module's
   * header for why there is no other safe order.
   *
   * **Throws synchronously, before anything is queued**, for a `put` over `MAX_FRAME_BYTES`:
   * `derive.ts` withholds such a file by its stat, so this is the second, load-bearing check
   * (a file can grow between that stat and its read), and it names the change at fault.
   */
  pushAll(changes: readonly Change[]): Promise<ResultOutcome>[] {
    for (const change of changes) {
      if (change.op === "put" && change.content.byteLength > MAX_FRAME_BYTES) {
        throw new Error(
          `Ctrl Notes: refusing to send ${change.path}: ${change.content.byteLength} bytes ` +
            `exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
        );
      }
    }
    const done = changes.map(
      (change) =>
        new Promise<ResultOutcome>((resolve, reject) => {
          this.pending.push({ change, resolve, reject });
        }),
    );
    this.trySend();
    return done;
  }

  /**
   * What this connection's vault accepts in one `put_batch` (`batch.ts`'s `batchLimitsFrom`).
   * Call from each `ready`, BEFORE `resume()`, so the re-send of whatever was in flight is
   * planned against the vault that is actually there.
   */
  setBatchLimits(limits: BatchLimits | null): void {
    this.limits = limits;
  }

  /**
   * Call once a fresh connection is ready to send again — after the very first handshake,
   * and after every reconnect. Whatever was in flight when the LAST connection died is
   * still at the head of the queue (never removed except by its own reply), so this simply
   * tries it again — the one retry path this file has, and the one §11 relies on to be
   * safe: the same content, addressed by the same hash, lands at most once.
   *
   * A batch that was in flight is re-planned, not re-sent as it was: this connection's vault
   * may take a different batch, or none (`setBatchLimits`).
   */
  resume(): void {
    this.inFlight = 0;
    this.trySend();
  }

  /**
   * Whether a push is queued or in flight: `pending` keeps its head until a reply comes. A
   * parked device with one has sent something the vault may never have received — an idle
   * close that raced it drops the frame — so it must not stay parked (`main.ts` `onIdle`).
   */
  hasOutstanding(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Give up on this pump for good — call from `main.ts`'s `disconnectSyncing()`, never
   * `resume()` after this.
   *
   * **Blocker fix.** Before this, discarding a `Pump` (unpair, a `terminal` closing, or
   * unload) left every promise `push()` had handed out unsettled forever: `settlePush` is
   * the only thing that ever resolves one, and nothing calls it once the transport that
   * would have delivered a reply is gone. `main.ts`'s `pushTouched` awaits that promise
   * directly, so `this.syncing` latched `true` for the rest of the plugin instance's life —
   * every later edit stopped pushing, silently, with no error and no retry. Rejecting here
   * gives that `await` somewhere to go: `pushTouched`'s own `catch` is what puts the change
   * back on `this.touched` for the next connection to pick up.
   */
  abandon(): void {
    const queued = this.pending.splice(0, this.pending.length);
    this.inFlight = 0;
    for (const q of queued) {
      q.reject(
        new Error(`Ctrl Notes: sync connection closed before ${q.change.path} was acknowledged`),
      );
    }
  }

  private trySend(): void {
    if (this.inFlight > 0 || this.pending.length === 0) return;
    const n = planBatch(
      this.pending.map((q) => q.change),
      this.limits,
    );
    const heads = this.pending.slice(0, n);
    this.inFlight = n;
    try {
      if (n >= 2) this.sendBatch(heads.map((q) => q.change));
      else if (heads[0] !== undefined) this.sendChange(heads[0].change);
    } catch (e) {
      // **Nothing reached the vault, so nothing is in flight.** `SyncSocket` throws before
      // its handshake completes, and before this catch existed the head stayed queued with
      // `inFlight` set while its promise rejected: the caller re-dirtied the path and
      // re-derived it, and the next `resume()` ALSO re-sent the stale head — two puts for one
      // edit, and the outcome of the older one applied to the ledger. The heads are dropped
      // and rejected instead — every entry of a batch, since none of it was sent; the caller
      // owns the retry. Anything queued behind them waits for the next `resume()`.
      this.pending.splice(0, n);
      this.inFlight = 0;
      for (const head of heads) head.reject(e);
    }
  }

  /**
   * The header, then exactly one binary frame per entry, in order — zero-length for an empty
   * file, and nothing between them (`wire.ts`'s `UpPutBatch`). `planBatch` admits only puts
   * that fit one frame, which is what makes one frame per entry possible.
   */
  private sendBatch(changes: readonly Change[]): void {
    const puts = changes.flatMap((c) => (c.op === "put" ? [c] : []));
    this.deps.transport.send({
      type: "put_batch",
      puts: puts.map((c) => ({
        path: c.path,
        base_sha: c.base,
        sha: c.hash,
        bytes: c.content.byteLength,
      })),
    });
    for (const c of puts) this.deps.transport.sendBinary(c.content);
  }

  private sendChange(change: Change): void {
    if (change.op === "put") {
      this.deps.transport.send({
        type: "put",
        path: change.path,
        base_sha: change.base,
        sha: change.hash,
        bytes: change.content.byteLength,
      });
      for (const piece of chunk(change.content, PUT_CHUNK_BYTES)) {
        this.deps.transport.sendBinary(piece);
      }
      return;
    }
    if (change.op === "delete") {
      this.deps.transport.send({ type: "delete", path: change.path, base_sha: change.base });
      return;
    }
    // `Up::Rename` carries no `base_sha` at all (`wire.rs`) — `change.base` exists only for
    // this device's own bookkeeping (`derive.ts` sets it from the source's last-synced
    // hash) and never rides the wire.
    this.deps.transport.send({ type: "rename", from: change.from, to: change.path });
  }

  private settlePush(down: DownApplied | DownRefused): void {
    // A batch is answered by `applied_batch` alone: a single answer now names nothing this
    // device is waiting on.
    if (this.inFlight > 1) return;
    const head = this.pending.shift();
    this.inFlight = 0;
    if (head === undefined) return; // A reply with nothing outstanding — ignore, not throw.

    const outcome = applyResult(head.change, down);
    if (down.type !== "applied") {
      this.deps.onRefused?.(down);
    }
    // No `onCursor` call here: the vault DOES echo this device's own write back
    // as an ordinary `Down::Event` to the very connection that authored it — `run`'s
    // `cursor` in `apps/vault/src/http/routes/sync.rs` only advances inside `drain`, and
    // every connection (including the author's) subscribes to the same `sync_notify` that
    // fires right after the write commits, so the next `drain` sends the event straight
    // back. Advancing the PERSISTED cursor here, before that echo (or anything from another
    // device queued ahead of it in the same `select!` race) has actually arrived and been
    // acked, could leave `syncState.cursor` ahead of an event this device was never sent —
    // and a reload in that exact window makes `hello`'s `since_seq` skip it permanently.
    // `flushEvents` is what advances the cursor now, once the event has actually landed.
    head.resolve(outcome);
    this.trySend();
  }

  /**
   * Settle every entry of the batch in flight from its one answer, by path.
   *
   * **An entry the answer does not name is rejected, not left pending.** The vault promises
   * every entry appears in exactly one list; if one does not, waiting for it would hold the
   * queue for good, and a rejection is what `main.ts` turns into "derive it again next
   * settle". Both halves of a refusal behave as a single `refused` does: `onRefused`, then an
   * outcome carrying it for `retry.ts`.
   */
  private settleBatch(down: DownAppliedBatch): void {
    if (this.inFlight < 2) return; // Not an answer to anything outstanding — ignore it.
    const heads = this.pending.splice(0, this.inFlight);
    const applied = new Map(down.applied.map((e) => [e.path, e]));
    const refused = new Map(down.refused.map((e) => [e.path, e]));
    for (const head of heads) {
      const path = head.change.path;
      const a = applied.get(path);
      const r = refused.get(path);
      if (a !== undefined) {
        head.resolve(applyResult(head.change, { type: "applied", ...a }));
      } else if (r !== undefined) {
        const one: DownRefused = { type: "refused", ...r };
        this.deps.onRefused?.(one);
        head.resolve(applyResult(head.change, one));
      } else {
        head.reject(new Error(`Ctrl Notes: the vault's batch answer did not name ${path}`));
      }
    }
    // No `onCursor` here either, for `settlePush`'s reason: each entry's own echo arrives as
    // an ordinary `Event` and advances the cursor when it lands.
    this.inFlight = 0;
    this.trySend();
  }

  /**
   * **One flush at a time, in order.** `main.ts` hands frames over without
   * awaiting them, and each WebSocket message is its own task, so without
   * chaining a flush waiting on a fetch round trip overlaps the next one: a
   * fast later event is acked while a slow earlier one is still in flight,
   * and a reload in that window loses the earlier one. Found by the second
   * review of #158 — the pump tests awaited each `handleDown` in turn, which
   * serialised them by accident.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.flushDone = this.flushDone
      .then(() => this.flushEvents())
      .catch((e: unknown) => {
        console.warn("Ctrl Notes: an inbound flush failed", e);
      });
  }

  /** Ask the vault for an authoritative snapshot — the only way, on a live
   * connection, to get past an event this device could not apply. */
  private requestResync(): void {
    if (this.resyncRequested || this.outstanding.size === 0) return;
    this.resyncRequested = true;
    this.deps.transport.send({ type: "snapshot" });
  }

  private async flushEvents(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    if (batch.length === 0) return;

    const { applied, ackThrough, blocked } = await applyReplay(this.deps.vault, batch, {
      fetchBytes: this.deps.fetchBytes,
      // Per file, so the ledger is current before the host's watcher can turn
      // this device's own write into an outbound push. See `ApplyDeps`.
      onApplied: (a) => this.deps.onApplied([a]),
      // Read fresh per event: an earlier event in this batch may have moved it.
      ledger: this.deps.ledger,
      onKept: this.deps.onKept,
    });
    this.deps.onApplied(applied);

    // Never the batch's own highest seq (blocker fix): an event this build could not
    // actually apply — most of them, until write-surface design §8.1's fetch frame exists
    // — must not be acked past, or the resume point this device reports is a claim it
    // cannot back up and the change is gone for good (`apply.ts`'s `ReplayResult` header).
    // A redelivered seq that got through this time clears; a fresh failure
    // joins the set.
    for (const event of batch) {
      if (!blocked.includes(event.seq)) this.outstanding.delete(event.seq);
    }
    for (const seq of blocked) this.outstanding.add(seq);
    // Never at or past an event still outstanding, however well this batch
    // went. `outstanding`'s own comment says what acking past one costs.
    const floor = this.outstanding.size === 0 ? null : Math.min(...this.outstanding);
    if (ackThrough !== null && (floor === null || ackThrough < floor)) {
      this.deps.onCursor(ackThrough);
      this.ack(ackThrough);
    }
    this.requestResync();
  }

  /**
   * Pages of a snapshot received so far, and the `seq` they belong to.
   *
   * **A snapshot is authoritative — anything it does not name is trashed — so a
   * page is unusable on its own.** Applying page one of three deletes every
   * path in pages two and three. Nothing is applied until the page carrying
   * `more: false` arrives.
   */
  private snapshotPages: { seq: number; files: SnapshotEntry[] } | null = null;

  /**
   * The most entries this will accumulate before giving up.
   *
   * A vault that never sends `more: false` would otherwise grow this without
   * limit. Past the bound the accumulation is DISCARDED rather than applied —
   * applying a truncated authoritative list is the very deletion this whole
   * mechanism exists to prevent, so the safe failure is to stay behind.
   */
  private static readonly MAX_SNAPSHOT_ENTRIES = 500_000;

  /** A dropped connection invalidates a half-received snapshot. */
  forgetSnapshotPages(): void {
    this.snapshotPages = null;
  }

  private async applySnapshotFrame(down: DownSnapshot): Promise<void> {
    // A page for a different `seq` supersedes whatever was being collected: the
    // two describe the vault at different moments, and a list assembled from
    // both names neither.
    if (this.snapshotPages !== null && this.snapshotPages.seq !== down.seq) {
      this.snapshotPages = null;
    }
    const collected = this.snapshotPages ?? { seq: down.seq, files: [] };
    collected.files.push(...down.files);
    this.snapshotPages = collected;

    if (collected.files.length > Pump.MAX_SNAPSHOT_ENTRIES) {
      console.warn(
        `Ctrl Notes: abandoning a snapshot past ${Pump.MAX_SNAPSHOT_ENTRIES} entries: ` +
          "applying a truncated one would delete everything it had not yet named",
      );
      this.snapshotPages = null;
      return;
    }

    // Not the last page: hold everything. This is the rule the whole mechanism
    // rests on.
    if (down.more) {
      return;
    }

    const files = collected.files;
    this.snapshotPages = null;

    // `applySnapshot` calls `planSnapshot` itself (`apply.ts`) — rule 2's trashing of
    // anything the snapshot omits, and the fetch of anything new or changed, both happen
    // inside it. Nothing here needs to compute that split a second time.
    const giveUp = new Set(
      [...this.localFailures].filter(([, n]) => n >= Pump.MAX_LOCAL_FAILURES).map(([p]) => p),
    );
    const { applied, complete, threw } = await applySnapshot(
      this.deps.vault,
      this.deps.ledger(),
      files,
      {
        fetchBytes: this.deps.fetchBytes,
        onApplied: (a) => this.deps.onApplied([a]),
        onUnavailable: this.deps.onUnavailable,
        onKept: this.deps.onKept,
      },
      { attachments: this.deps.attachments },
      giveUp,
    );
    this.deps.onApplied(applied);
    // Answered, whether or not it completed: the next block may ask again.
    this.resyncRequested = false;
    // Consecutive failures only — a path that went through this time starts
    // again from nothing.
    const failedNow = new Set(threw);
    for (const path of [...this.localFailures.keys()]) {
      if (!failedNow.has(path) && !giveUp.has(path)) this.localFailures.delete(path);
    }
    for (const path of threw) this.localFailures.set(path, (this.localFailures.get(path) ?? 0) + 1);
    // Only ack a snapshot this device actually matches now (blocker fix) — a partial
    // snapshot acked as done tells the vault this device caught up when it did not, and
    // nothing rescans later to notice (`apply.ts`'s `SnapshotResult` header).
    if (complete) {
      // A complete snapshot IS this device's state, so an event it could not
      // apply earlier is moot: the snapshot already says what every path holds
      // now. This is the release valve for `outstanding` — without it an
      // event nothing can ever apply would hold the cursor for the life of
      // the device.
      this.outstanding.clear();
      for (const path of giveUp) this.localFailures.delete(path);
      this.deps.onCursor(down.seq);
      this.ack(down.seq);
    }
  }

  private ack(seq: number): void {
    this.deps.transport.send({ type: "ack", seq });
    this.deps.transport.noteAck(seq);
  }
}
