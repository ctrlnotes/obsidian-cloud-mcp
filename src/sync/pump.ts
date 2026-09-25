// Events down, content up (write-surface design §8.1–§8.3, §8.4) — the layer that turns a
// connected `SyncSocket` (Task 9) into applied files and acknowledged, retried pushes.
// Greenfield, like Task 9: nothing in glass-1 ports here, because its wire had a batch
// (`applyResults` correlating `results[i]` to `sent[i]` by index) and a separate HTTP
// content channel that this protocol does not have.
//
// **One push, one answer, no batching, no index to get wrong** (`results.ts`'s own doc
// comment, restated here because it drives this file's whole outbound shape): our wire
// answers exactly one `Up::Put`/`Delete`/`Rename` with exactly one `Down::Applied` or
// `Down::Refused`, in order. So `push` is single-flight — a second call queues behind
// whichever change is already in flight rather than racing it, because there would be no
// way to tell two outstanding replies apart.
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
  DownEvent,
  DownRefused,
  DownSnapshot,
  SnapshotEntry,
  Up,
} from "../wire.ts";
import { MAX_FRAME_BYTES } from "../wire.ts";
import {
  type Applied,
  type ApplyDeps,
  applyReplay,
  applySnapshot,
  type VaultFiles,
} from "./apply.ts";
import type { Change, DeriveOptions } from "./derive.ts";
import { applyResult, type ResultOutcome } from "./results.ts";

/**
 * How large one binary frame is while streaming a `put`'s content up.
 *
 * **Not `MAX_FRAME_BYTES`.** That is the vault's hard wall on the WHOLE upload
 * (`wire.ts`'s own doc comment; `derive.ts` already refuses a `Change` over it before one
 * is ever built) — this is a separate, much smaller choice about how many WebSocket frames
 * one upload is split into on the way up. A large attachment sent as a single message would
 * still be under the wall, but it would hold the socket's send buffer at multiple megabytes
 * for the duration; slicing it costs nothing on the wire (`Upload::push` in
 * `apps/vault/src/sync/upload.rs` already assembles arbitrarily many chunks) and never
 * blocks the socket for longer than one small write.
 */
const PUT_CHUNK_BYTES = 256 * 1024;

/** The slice of `SyncSocket` this module drives — narrow, the same reasoning as
 * `device.ts`'s `SecretStorageHost`: a test hands this a plain object, never a real socket. */
export interface SyncTransport {
  send(up: Up): void;
  sendBinary(bytes: Uint8Array): void;
  /** Told once a batch of inbound events (or a snapshot) has been fully applied, so the
   * NEXT reconnect resumes from here rather than from a seq merely seen (Task 9's header). */
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
 * **Owns no socket.** `main.ts` (Task 13) is what feeds this class's `handleDown` every
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
  private inFlight = false;

  constructor(private readonly deps: PumpDeps) {}

  /**
   * Route one `Down` frame that arrived after the handshake. `challenge`/`ready`/`closing`
   * never reach here — those are `SyncSocket`'s own business (Task 9).
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
      default:
        return Promise.resolve(); // challenge / ready / closing: not this file's concern.
    }
  }

  /**
   * Send one local change and resolve once the vault has answered it.
   *
   * **Single-flight, queued.** A second call while one push is already outstanding is
   * appended and sent only once the first resolves — see this module's header for why
   * there is no other safe order on a wire with no batching.
   *
   * **Throws synchronously, before anything is queued**, for a `put` over
   * `MAX_FRAME_BYTES`. Checked here rather than at actual send time on purpose: this
   * change might sit behind others in `pending` for a while, and a throw from deep inside
   * `trySend` — reached later, from `settlePush` resolving something else entirely — would
   * surface at a call site with no connection to the change that caused it. `derive.ts`
   * already refuses anything this large before a `Change` is ever built, so reaching here
   * at all means that guarantee broke somewhere upstream; this is the second, load-bearing
   * place content leaves the device, not a decoration on the first.
   */
  push(change: Change): Promise<ResultOutcome> {
    if (change.op === "put" && change.content.byteLength > MAX_FRAME_BYTES) {
      throw new Error(
        `Ctrl Notes: refusing to send ${change.path}: ${change.content.byteLength} bytes ` +
          `exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ change, resolve, reject });
      this.trySend();
    });
  }

  /**
   * Call once a fresh connection is ready to send again — after the very first handshake,
   * and after every reconnect. Whatever was in flight when the LAST connection died is
   * still at the head of the queue (never removed except by its own reply), so this simply
   * tries it again — the one retry path this file has, and the one §11 relies on to be
   * safe: the same content, addressed by the same hash, lands at most once.
   */
  resume(): void {
    this.inFlight = false;
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
    this.inFlight = false;
    for (const q of queued) {
      q.reject(
        new Error(`Ctrl Notes: sync connection closed before ${q.change.path} was acknowledged`),
      );
    }
  }

  private trySend(): void {
    if (this.inFlight || this.pending.length === 0) return;
    const head = this.pending[0];
    if (head === undefined) return;
    this.inFlight = true;
    try {
      this.sendChange(head.change);
    } catch (e) {
      // **Nothing reached the vault, so nothing is in flight.** `SyncSocket` throws before
      // its handshake completes, and before this catch existed the head stayed queued with
      // `inFlight` set while its promise rejected: the caller re-dirtied the path and
      // re-derived it, and the next `resume()` ALSO re-sent the stale head — two puts for one
      // edit, and the outcome of the older one applied to the ledger. The head is dropped
      // and rejected instead; the caller owns the retry. Anything queued behind it waits
      // for the next `resume()`.
      this.pending.shift();
      this.inFlight = false;
      head.reject(e);
    }
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
    const head = this.pending.shift();
    this.inFlight = false;
    if (head === undefined) return; // A reply with nothing outstanding — ignore, not throw.

    const outcome = applyResult(head.change, down);
    if (down.type !== "applied") {
      this.deps.onRefused?.(down);
    }
    // No `onCursor` call here (minor fix): the vault DOES echo this device's own write back
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
