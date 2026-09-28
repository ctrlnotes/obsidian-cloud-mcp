// Turning `want` -> `blob` + frames back into `fetchBytes(sha)`.
//
// **Correlation is by position, not by id.** The vault answers the shas of one
// `want` in order, and the binary frames of one blob are contiguous — nothing
// is sent between a `blob` header and its last frame. So this holds exactly one
// outstanding request, the mirror of the vault's single in-flight `Upload`, and
// the bytes that arrive belong to whatever header came last. Adding request ids
// would buy interleaving, which the vault deliberately does not do (design
// §7.2): contiguity is what keeps this small.
//
// **A `no_blob` is an answer, not a failure**, and the difference is the whole
// reason this module distinguishes three outcomes rather than two. See
// `apply.ts` for what each one does to the cursor.

import type { Down, Up } from "../wire.ts";
import { MAX_WANT_SHAS } from "../wire.ts";

/** What one fetch produced. */
export type Fetched =
  | { readonly ok: true; readonly bytes: Uint8Array }
  /** The vault says it will never have this. Do not retry; do not stall the cursor. */
  | { readonly ok: false; readonly permanent: true; readonly reason: string }
  /** The socket died, or this fetch was abandoned. Retrying is the right response. */
  | { readonly ok: false; readonly permanent: false; readonly reason: string };

/**
 * One outstanding `want`, which may name several shas.
 *
 * The vault answers them IN ORDER, each as a header plus contiguous frames, so
 * `expect` is a queue: the header that arrives belongs to `expect[0]`, and the
 * bytes that follow belong to whatever header came last. That positional
 * reading is the whole reason the protocol needs no request ids, and it is why
 * this holds one request at a time rather than several.
 */
interface Pending {
  /** Shas still unanswered, in the order the vault will answer them. */
  readonly expect: string[];
  /** The blob being received right now: its length, and what has arrived. */
  current: { sha: string; want: number; chunks: Uint8Array[]; got: number } | null;
  readonly got: Map<string, Fetched>;
  readonly settle: (all: Map<string, Fetched>) => void;
}

export interface FetcherDeps {
  /** Send one `Up` frame. Returns false when there is no live socket. */
  readonly send: (up: Up) => boolean;
  /**
   * Milliseconds of SILENCE before an outstanding request gives up: re-armed by
   * every header and binary frame the request consumes, so a long batch that
   * is still arriving is never failed for its length alone.
   */
  readonly timeoutMs?: number;
  /** The most shas one `want` names. Defaults to, and may not exceed, {@link MAX_WANT_SHAS}. */
  readonly maxShas?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class Fetcher {
  private pending: Pending | null = null;
  private queue: Array<{ start: () => void; fail: (reason: string) => void }> = [];
  private timer: number | null = null;

  private readonly maxShas: number;

  constructor(private readonly deps: FetcherDeps) {
    this.maxShas = Math.max(1, Math.min(deps.maxShas ?? MAX_WANT_SHAS, MAX_WANT_SHAS));
  }

  /** Ask for one sha — {@link wantMany} with a list of one. */
  async want(sha: string): Promise<Fetched> {
    const answers = await this.wantMany([sha]);
    return answers.get(sha) ?? { ok: false, permanent: false, reason: "no_answer" };
  }

  /**
   * Ask for several shas, as few `want` frames as the wire allows: at most
   * {@link MAX_WANT_SHAS} per frame, one frame in flight at a time. Every sha
   * asked for has an entry in the answer; duplicates are asked for once.
   *
   * **Batched, reversing an earlier measured choice — and the old reason still
   * stands where it applied.** One sha per request was chosen from a 250-file
   * first sync on a local setup, where the round trip was negligible: batch 1 was
   * 48 ms/file and completed; batch 16 was 366 ms/file and stalled at 238
   * files; batch 64 was 443 ms/file and stalled at 190. At 48 ms/file the cost
   * was server work, not the round trip, so batching bought nothing there and
   * its contiguous multi-blob bursts held up the events sharing the socket.
   *
   * **Production goes over the internet, where the round trip dominates**, and
   * that is why batching should now win: a device catching up on a bulk change
   * fetched about 3,600 paths at roughly 6.5 per second, one per round trip, so
   * slowly that its snapshot could not finish before the vault closed the
   * connection for 1,000 unacknowledged events — and under the ack rule
   * (`pump.ts`'s `outstanding`) it acked nothing until a snapshot finished, so
   * it looped.
   *
   * **Why the old batches stalled is still unexplained.** Two candidates:
   * - the timeout then bounded a WHOLE request at 30 s. 64 × 443 ms ≈ 28 s sits
   *   at that edge, so it fits batch 64; 16 × 366 ms ≈ 6 s does not, so it
   *   cannot explain batch 16. It now measures silence instead.
   * - a device pushing its own downloads straight back up, whose upload storm
   *   starved `want`s on the same socket into timeouts (`apply.ts`'s
   *   `onApplied` says how that was fixed) — if the old run predates that fix.
   *
   * Neither is confirmed, so **a release carrying this is gated on a real bulk
   * catch-up measured over the internet**: ms/file at batch 1, 16 and 64
   * ({@link FetcherDeps.maxShas}).
   *
   * **Every chunk is queued up front**, one `want` per {@link MAX_WANT_SHAS}
   * shas, and they go out one after another. Catch-up callers pass at most one
   * window's worth (`apply.ts`), so this is one frame in practice; a longer list
   * holds the queue until it is all answered.
   */
  async wantMany(shas: readonly string[]): Promise<Map<string, Fetched>> {
    const unique = [...new Set(shas)];
    const answers = new Map<string, Fetched>();
    const requests: Promise<Map<string, Fetched>>[] = [];
    for (let at = 0; at < unique.length; at += this.maxShas) {
      // Queued together, sent one after another: `request` holds one `want`
      // outstanding and starts the next when the last answer lands.
      requests.push(this.request(unique.slice(at, at + this.maxShas)));
    }
    for (const got of await Promise.all(requests)) {
      for (const [sha, fetched] of got) answers.set(sha, fetched);
    }
    return answers;
  }

  /** One `want` naming `shas`, resolved when every one has been answered. */
  private request(shas: readonly string[]): Promise<Map<string, Fetched>> {
    return new Promise<Map<string, Fetched>>((resolve) => {
      const fail = (reason: string) => {
        const m = new Map<string, Fetched>();
        for (const s of shas) m.set(s, { ok: false, permanent: false, reason });
        resolve(m);
      };
      const start = () => {
        if (!this.deps.send({ type: "want", shas: [...shas] })) {
          fail("no_socket");
          this.next();
          return;
        }
        this.pending = {
          expect: [...shas],
          current: null,
          got: new Map(),
          settle: resolve,
        };
        this.armTimer();
      };
      if (this.pending === null) start();
      else this.queue.push({ start, fail });
    });
  }

  /** A `blob` or `no_blob` header. Returns true when it was ours to consume. */
  onFrame(down: Down): boolean {
    const p = this.pending;
    if (p === null) return false;
    const next = p.expect[0];
    if (down.type === "no_blob") {
      if (next !== down.sha) return false;
      p.expect.shift();
      p.got.set(down.sha, { ok: false, permanent: true, reason: down.reason });
      this.maybeDone();
      return true;
    }
    if (down.type !== "blob") return false;
    if (next !== down.sha) return false;
    if (down.bytes === 0) {
      // A zero-byte file has no frames at all, so it completes on its header.
      p.expect.shift();
      p.got.set(down.sha, { ok: true, bytes: new Uint8Array(0) });
      this.maybeDone();
      return true;
    }
    p.current = { sha: down.sha, want: down.bytes, chunks: [], got: 0 };
    this.armTimer();
    return true;
  }

  /** One binary frame. Returns true when it was ours to consume. */
  onBytes(bytes: Uint8Array): boolean {
    const p = this.pending;
    // No header has named a length, so these bytes belong to nothing asked for.
    // Dropping is right: appending them to whatever opens next would corrupt it.
    if (p === null || p.current === null) return false;
    const c = p.current;
    c.chunks.push(bytes);
    c.got += bytes.byteLength;
    if (c.got < c.want) {
      this.armTimer();
      return true;
    }

    p.expect.shift();
    p.current = null;
    if (c.got > c.want) {
      // More bytes than the header declared: the frames are no longer
      // trustworthy as a unit, so this fails rather than truncating. A
      // truncated file on disk is worse than one not written, because the
      // ledger would record a hash for content the vault does not hold.
      p.got.set(c.sha, { ok: false, permanent: false, reason: "overrun" });
    } else {
      const joined = new Uint8Array(c.want);
      let at = 0;
      for (const part of c.chunks) {
        joined.set(part, at);
        at += part.byteLength;
      }
      p.got.set(c.sha, { ok: true, bytes: joined });
    }
    this.maybeDone();
    return true;
  }

  /**
   * Whether a `want` is awaiting its answer or queued behind one. A device about to park
   * with one would strand it: the idle close fails it as transient, and nothing asks again
   * until something reconnects (`main.ts` `onIdle`).
   */
  hasOutstanding(): boolean {
    return this.pending !== null || this.queue.length > 0;
  }

  /**
   * The socket died. Everything outstanding, queued and cached fails as
   * TRANSIENT — a reconnect is exactly the case where retrying is right.
   */
  reset(reason = "disconnected"): void {
    const p = this.pending;
    this.clearTimer();
    this.pending = null;
    const queued = this.queue;
    this.queue = [];
    if (p !== null) {
      for (const s of p.expect) p.got.set(s, { ok: false, permanent: false, reason });
      p.settle(p.got);
    }
    // Failed, not re-run: re-running a starter here would have each set
    // `pending` in turn and clobber the others if the socket were alive again.
    for (const q of queued) q.fail(reason);
  }

  private maybeDone(): void {
    const p = this.pending;
    if (p === null) return;
    if (p.expect.length > 0) {
      this.armTimer(); // An answer landed: progress, so the silence starts again.
      return;
    }
    this.clearTimer();
    this.pending = null;
    p.settle(p.got);
    this.next();
  }

  private next(): void {
    const n = this.queue.shift();
    if (n !== undefined) n.start();
  }

  /** (Re)start the silence timer for the outstanding request. */
  private armTimer(): void {
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      const p = this.pending;
      this.timer = null;
      this.pending = null;
      if (p !== null) {
        for (const s of p.expect) {
          p.got.set(s, { ok: false, permanent: false, reason: "timeout" });
        }
        p.settle(p.got);
      }
      this.next();
    }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}
