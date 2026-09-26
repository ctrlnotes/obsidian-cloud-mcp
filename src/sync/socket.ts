// The plugin's one duplex connection to its vault (write-surface design §8.1, §8.5).
//
// **Ours, not a port.** an earlier prototype's `stream.ts` is a hint-only channel: a poke that tells the
// caller to run an ordinary HTTP exchange, with no credential proof beyond a subprotocol
// string. This socket IS the sync channel — events flow down it, content flows up it — and
// admission is a signed challenge, not a bearer credential (design §8.5). Only the
// reconnect/backoff *shape* (first-retry, ceiling, jittered doubling, a "stayed up long
// enough" reset) is carried across; everything about what rides the socket is new.
//
// **Rule 3 lives here.** `vaultId` is a constructor dependency — the plugin's own stored
// value — and is never read from anything the vault sends. The `challenge` frame carries no
// vault id on purpose (design §8.5): a server that told a client what to sign could get it
// to sign for a vault it never chose. See `answerChallenge` and `terminal`.
//
// **A `closing` frame says whether to retry, in a field, and only the field decides**
// (bulk-ingest design BI1). `retry: "never"` — an unknown or revoked device, a version
// mismatch, a protocol bug — is a reason a human, not a retry, has to fix: `terminal`,
// reported once through `onClosing`, no retry scheduled, and `connect()` must be called again
// deliberately (`main.ts`, once the human has acted) to resume. Anything else — `later`, an
// absent field (a v3 vault that predates it), a value this build has never heard of — gets
// the SAME backoff-and-retry an ordinary dropped connection gets (`resumable`), because
// retrying against a vault that will refuse again costs one request per backoff step, and
// giving up against one that would have recovered costs the whole sync. That trade is the
// lesson of 2026-09-25: a busy vault answered `handshake timed out`, this module read the
// unrecognised text as terminal, the socket closed, and with no traffic Fly suspended the
// vault in the middle of a first sync that then never finished.
//
// Until BI1 the decision was an exact match on the reason's text against a set of two
// "resumable" sentences, and every other sentence — including ones the vault added later —
// was terminal. The text still chooses HOW to retry for two reasons below (a restart waits a
// fixed delay, an idle close parks), both of which are `later` on the wire; it never again
// chooses WHETHER to.
//
// **While this device has work in flight, a retry waits at most `WORK_RETRY_MAX_MS`** (BI4),
// however far the backoff has climbed: see that constant for why. An ordinary dropped
// connection — the network died, the vault process crashed — takes the same path for the
// obvious reason: no frame told us anything.
//
// **A vault restarting for an update is neither, and gets a third treatment** (staged
// rollout design §5). On SIGTERM the vault sends `closing` with `VAULT_RESTART_REASON`, then
// closes the socket with code 1012, "Service Restart" (RFC 6455). Either signal alone is
// enough: this module reports it through `onRestarting` and reconnects after a short FIXED
// delay (`RESTART_RECONNECT_MS`), leaving the backoff exactly where it was. A restart is the
// vault doing what it was told to, not this connection failing, so it must not push the next
// genuine failure further up the ladder — and a rollout that walks every vault must not
// leave every device waiting out a doubled backoff for a machine that is back in seconds.
//
// **A vault letting go of an idle socket is a fourth, and the plugin PARKS on it** (vault-sleep
// design VS1, VS4). After 90 s with no traffic the vault sends `closing` with `IDLE_REASON`
// and closes with 1000, so that its machine can suspend. Nothing failed, nobody needs telling
// and nothing is retried: this module reports it through `onIdle`, schedules nothing, and
// leaves the next `connect()` to the caller, which makes one when there is something to sync
// (`main.ts`'s `wake`). Unlike `terminal`, the backoff and the acked position are untouched,
// so that `connect()` resumes exactly where this connection left off.
//
// **A mismatched vault id presents as an opaque `closing`, and only the client can name
// why.** The vault verifies `context_message(its own vault_id, challenge)`; if this plugin
// signed for a different id, the signature simply fails to verify, and the vault answers
// with the same "not authorised" it gives an unknown or revoked device — distinguishing
// them would tell an attacker whether a device id exists. So when a `closing` that stops
// sync arrives while we are still waiting on our own `hello` to be answered, the message this
// module reports names the vault id it signed for — the one piece of diagnosis only this side
// can do. A closing this module retries after is reported in the vault's own words: the pane
// quotes it as what the vault said (`status.ts`), and a v3 vault's "not authorised", the one
// retried refusal where the id could matter, carries advice that names it anyway.

import type { DeviceIdentity } from "../device.ts";
import { type Down, decodeDown, encodeUp, readDownFrame, type Up } from "../wire.ts";

/**
 * The minimal transport this module drives — deliberately not the DOM `WebSocket` type
 * itself, so a test can hand it a fake with no real socket underneath, the same reasoning
 * as `device.ts`'s `SecretStorageHost`. Obsidian's own runtime (desktop Electron, and the
 * mobile WebView) provides a real `WebSocket` global that already satisfies this shape;
 * `main.ts` is what actually passes `(url) => new WebSocket(url)` as the factory.
 */
export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  /** `code` is the WebSocket close code a real `CloseEvent` carries. Optional because a
   * transport that cannot say (or a test's plain drop) is an ordinary drop. */
  onclose: ((event?: { readonly code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const FIRST_RETRY_MS = 1_000;
/** The backoff's ceiling — and so, by BI1, the most often a device retries a vault that keeps
 * refusing it without saying `never`. */
export const MAX_RETRY_MS = 5 * 60_000;

/**
 * The longest a reconnect waits while this device has work outstanding (bulk-ingest design
 * BI4: a socket with work in flight is not idle).
 *
 * **Far below Fly's autostop, on purpose.** An open WebSocket is what Fly's proxy counts as
 * load; a vault with none for ~5–8 minutes suspends (measured:
 * `docs/measurements/2026-09-23-fly-autostop-and-wake` in the service repository). The
 * ordinary backoff climbs to five minutes, so a device mid-upload that took two busy closes
 * in a row could leave its vault quiet long enough to be put to sleep with the upload
 * unfinished — which is how the 2026-09-25 first sync ended. 30 s keeps the vault seeing a
 * connection attempt well inside that window, and a vault answering `busy` is about to have
 * a free write permit, so waiting longer buys nothing.
 */
export const WORK_RETRY_MAX_MS = 30_000;

/**
 * How long the next reconnect waits: full jitter over `[retryMs/2, retryMs)`, capped at
 * {@link WORK_RETRY_MAX_MS} while this device has work outstanding.
 *
 * Pure, so the cap can be tested as a property rather than through a clock. `retryMs` itself
 * keeps its exact doubling to {@link MAX_RETRY_MS} (see `scheduleRetry`); the cap shortens the
 * wait, never the ladder, so a device whose queue empties is back on the ordinary backoff at
 * once.
 */
export function retryWait(retryMs: number, r: number, hasWork: boolean): number {
  const w = retryMs / 2 + r * (retryMs / 2);
  return hasWork ? Math.min(w, WORK_RETRY_MAX_MS) : w;
}

/** RFC 6455 §7.4.1 close code 1012, "Service Restart" — what the vault closes a sync socket
 * with on SIGTERM (staged rollout plan §1.3). */
export const SERVICE_RESTART_CLOSE_CODE = 1012;

/**
 * How long after a vault restart to reconnect. Fixed, not the backoff: an update replaces the
 * machine in seconds, and the first attempt landing while it is still down costs nothing — a
 * failed reconnect is an ordinary drop and takes the ordinary backoff from there.
 */
export const RESTART_RECONNECT_MS = 3_000;

/**
 * The `closing` reason the vault sends immediately BEFORE its 1012 close (plan §1.3). Matched
 * by exact text, and pinned in `vault-reasons.test.ts`.
 *
 * **Text chooses how to retry here, never whether.** The frame says `retry: "later"` like any
 * other temporary close, and unrecognised it would be retried on the ordinary backoff; what
 * the text buys is the short FIXED delay a restart deserves (`RESTART_RECONNECT_MS`) and a
 * backoff left where it was. Before BI1 an unrecognised `closing` was `terminal`, which made
 * matching this text the only thing standing between a routine update and a stopped sync.
 */
export const VAULT_RESTART_REASON =
  "the vault is restarting for an update; reconnect in a few seconds";

export function isRestartClosing(reason: string): boolean {
  return reason === VAULT_RESTART_REASON;
}

/**
 * The `closing` reason the vault sends when a socket has been silent for its idle timeout
 * (vault-sleep design VS1), immediately before closing with 1000. Matched by exact text and
 * pinned in `vault-reasons.test.ts`, for the reason {@link VAULT_RESTART_REASON} is.
 *
 * **Recognising it is what makes an idle close a park rather than a reconnect loop.** The
 * frame says `retry: "later"`; unrecognised, this device would reconnect on the backoff and
 * keep the vault awake for nothing, which is the one thing parking exists to stop. It was
 * worse before BI1: unrecognised meant `terminal`, a Notice every 90 s of quiet and no sync
 * until Obsidian restarted — which is why `WIRE_VERSION` went to 3 with it (VS2).
 */
export const IDLE_REASON = "idle; reconnect when there is something to sync";

export function isIdleClosing(reason: string): boolean {
  return reason === IDLE_REASON;
}

/**
 * How long a connection must stay past the handshake before a drop is treated as a fresh
 * failure rather than a continuation of whatever caused the last one.
 *
 * Not "a frame arrived" — every completed handshake gets a `ready`, so that would forgive
 * the backoff on a vault that accepts, greets, and immediately drops, which is exactly the
 * reconnect-once-a-second loop backoff exists to prevent. Duration is the one signal a
 * flapping connection cannot fake.
 */
const STABLE_MS = 30_000;

/**
 * A binary frame as bytes, whatever the host handed us.
 *
 * The three runtimes this plugin meets disagree: Obsidian's desktop Electron and
 * node give an `ArrayBuffer` or a `Buffer`, and a browser `WebSocket` left at its
 * default `binaryType` gives a `Blob`, which is only readable asynchronously. All
 * three are normalised here so the rest of the plugin sees one shape.
 */
const asBytes = async (raw: unknown): Promise<Uint8Array | null> => {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  const blob = raw as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob?.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return null;
};

export interface SyncSocketDeps {
  /**
   * The URL to open, minted FOR EACH CONNECTION.
   *
   * **A function, not a string, because the URL carries a signed routing proof
   * with a freshness window** (device-approval O6): the control plane has to
   * choose which vault to replay into before any socket exists to run a
   * challenge over, and the plugin cannot set headers on an upgrade. A URL
   * captured once would be stale on the first reconnect — which is exactly
   * when a socket is reopened — so it is minted per attempt.
   */
  readonly url: () => Promise<string>;
  /** This device's own record of which vault it is talking to (rule 3) — never the frame's. */
  readonly vaultId: string;
  readonly deviceId: string;
  readonly identity: Pick<DeviceIdentity, "signChallenge">;
  readonly createSocket: SocketFactory;
  /** Every `Down` frame from `ready` onward. `challenge` is consumed inside this module and
   * never reaches here; `closing` reaches here too, immediately before `onClosing` fires. */
  readonly onFrame: (down: Down) => void;
  /** One binary frame — the content following a `blob` header. Separate from `onFrame`
   * because the two are different kinds of thing: a `Down` is a decoded statement, this is
   * a slice of a file whose meaning comes entirely from the header that preceded it.
   *
   * Optional: a caller that never sends `want` never receives one, and every test that
   * drives this class for other reasons should not have to supply a handler for content
   * it will never be sent. */
  readonly onBytes?: (bytes: Uint8Array) => void;
  /**
   * A `closing` frame arrived. `willRetry` says which treatment this one got (this
   * module's header): `false` is `retry: "never"` — reported once, no retry follows,
   * `connect()` must be called again deliberately, and `message` names the vault id this
   * device signed for when the refusal answered its hello. `true` means `message` is the
   * vault's reason verbatim, and this module is already retrying on its own with the
   * ordinary backoff, exactly like a dropped connection; a caller must NOT tear down anything it wants kept for that retry to use (`main.ts`'s
   * `onClosing` skips `disconnectSyncing()` for this case, or the `Pump` this class hands
   * frames to next would be gone).
   */
  readonly onClosing: (message: string, willRetry: boolean) => void;
  /**
   * The vault is restarting for an update (close code 1012, or its `closing` frame saying
   * so). A reconnect is already scheduled after `RESTART_RECONNECT_MS`; like a resumable
   * `onClosing`, a caller must not tear down what that reconnect will reuse. Optional: a
   * caller with nothing to show for it loses nothing but the status line.
   */
  readonly onRestarting?: () => void;
  /**
   * The vault closed this socket for being idle (`IDLE_REASON`). No retry is scheduled and
   * `onClosing` is NOT called: this is not a refusal. The caller keeps everything it holds
   * and calls `connect()` again when there is something to sync. Optional, like
   * `onRestarting`: a caller without it simply stays disconnected until it next connects.
   */
  readonly onIdle?: () => void;
  /**
   * Whether this device has work outstanding — an upload queued or in flight, a settle
   * deriving one, a change not yet derived (bulk-ingest design BI4). Read each time a retry
   * is scheduled; while it answers `true` a reconnect waits at most
   * {@link WORK_RETRY_MAX_MS}. Work that appears during a wait already running is reported
   * with `workArrived`. Optional: without it every retry takes the ordinary backoff.
   */
  readonly hasWork?: () => boolean;
  /** Jitter source for the backoff. Injectable so a test is deterministic; defaults to the
   * real `Math.random` in production, the same reasoning as an earlier prototype's `random`. */
  readonly random?: () => number;
  /** Passed through to {@link readDownFrame} for an unrecognised frame type; defaults to
   * that function's own `console.warn`. */
  readonly warn?: (message: string) => void;
}

/**
 * One logical connection to `/v1/sync`, reconnecting on its own after an ordinary drop and
 * resuming from the last **acknowledged** position, never the last one merely observed.
 *
 * §8.3: acking is what makes an event durable for this device. A reconnect that resumed
 * from the highest seq a `Down::Event` ever named would silently drop anything this device
 * saw but had not yet finished applying when the connection died.
 */
export class SyncSocket {
  private socket: SocketLike | null = null;
  private wanted = false;
  private timer: number | null = null;
  /** An `open()` is in flight but has no socket yet, because minting the URL means signing
   * a routing proof (O6). Bridges the one `await` between "decided to connect" and
   * "`this.socket` is set" — see `connect()`. */
  private opening = false;
  private stable: number | null = null;
  /**
   * When the pending backoff retry fires, in `Date.now()` time; `null` when `timer` is not
   * one — none pending, or a restart's fixed delay. What `workArrived` reads to know whether
   * the wait still running is longer than work may wait.
   */
  private retryAt: number | null = null;
  private retryMs = FIRST_RETRY_MS;
  private ready = false;
  /** True from the moment `hello` is sent until `ready` (or `closing`) answers it — the
   * window in which a `closing` gets the vault-id-naming treatment (see this module's
   * header). */
  private awaitingReadyAfterHello = false;
  private ackedSeq: number;
  /**
   * The version this connection's `hello` answered in: whatever the vault's `challenge`
   * named, within the range `decodeDown` accepts. Not a constant, because a v3 vault admits
   * only a v3 hello (`MIN_WIRE_VERSION`'s doc comment says why 3 is still spoken).
   */
  private wireVersion = 0;

  constructor(
    private readonly deps: SyncSocketDeps,
    /** The device's own last-acknowledged seq, persisted (`state.ts`'s `SyncState.cursor`)
     * across restarts — the value a brand-new install and a mid-session reconnect both feed
     * into `hello` the same way. */
    sinceSeq: number,
  ) {
    this.ackedSeq = Math.max(0, sinceSeq);
  }

  /** Idempotent, matching an earlier prototype's reasoning: a second call while a socket or a retry
   * timer is already live must not leave the first one running and unreachable.
   *
   * **`opening` is part of that guard and cannot be dropped.** Since the URL carries a
   * signed proof (O6), there is now an `await` between deciding to connect and having a
   * socket to check for — a window in which `this.socket` and `this.timer` are both still
   * `null`. Without this flag a second `connect()`, or a retry timer firing, passes the
   * guard and opens a SECOND socket; the first is then overwritten, so nothing ever closes
   * it and it counts against the vault's `sync_max_connections_per_device` until it dies of
   * its own accord. */
  connect(): void {
    this.wanted = true;
    if (this.socket !== null || this.timer !== null || this.opening) return;
    this.open();
  }

  /**
   * Skip a scheduled reconnect and make it now — "Sync now" during a drop's backoff. Returns
   * whether there was one to skip: `false` while a connection is open or already being made,
   * and while none is wanted. The backoff itself is left where it is, so a failure of this
   * attempt waits exactly as long as the one it replaced would have been followed by.
   */
  reconnectNow(): boolean {
    if (!this.wanted || this.timer === null) return false;
    window.clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = null;
    this.open();
    return true;
  }

  /**
   * This device has work now (BI4): a backoff retry still more than
   * {@link WORK_RETRY_MAX_MS} away is brought inside it. Returns whether one was.
   *
   * `hasWork` is read when a retry is SCHEDULED, so without this a device that went quiet on a
   * long outage — its backoff climbed to five minutes with nothing queued — and then had a
   * folder of notes dropped into it would sit out the whole wait before uploading any. The
   * rung is untouched, as `retryWait` leaves it: only this one wait is shortened, and it is
   * jittered over `[WORK_RETRY_MAX_MS/2, WORK_RETRY_MAX_MS)` like any other.
   */
  workArrived(): boolean {
    if (!this.wanted || this.timer === null || this.retryAt === null) return false;
    if (this.retryAt - Date.now() <= WORK_RETRY_MAX_MS) return false;
    window.clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = null;
    const random = this.deps.random ?? Math.random;
    this.armRetry(retryWait(WORK_RETRY_MAX_MS, random(), true));
    return true;
  }

  /** Deliberate close: no reconnect follows. Called on unload. */
  disconnect(): void {
    this.wanted = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket === null) return;
    this.detach(socket);
    socket.close();
  }

  /**
   * This device has applied everything up to `seq`. The **next** connection's `hello`
   * resumes from here — see this class's own header for why that must be the acked
   * position, not the highest seq a `Down::Event` merely arrived carrying.
   */
  noteAck(seq: number): void {
    this.ackedSeq = Math.max(this.ackedSeq, seq);
  }

  /** Only valid once the handshake has completed — `pump.ts` is expected to hold sends
   * until it has seen `ready` (or an earlier frame) via `onFrame`. */
  send(up: Up): void {
    if (this.socket === null || !this.ready) {
      throw new Error("Ctrl Notes: cannot send before the sync handshake completes");
    }
    this.socket.send(encodeUp(up));
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.socket === null || !this.ready) {
      throw new Error("Ctrl Notes: cannot send content before the sync handshake completes");
    }
    this.socket.send(bytes);
  }

  get isReady(): boolean {
    return this.ready;
  }

  private detach(socket: SocketLike): void {
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private clearTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.stable !== null) window.clearTimeout(this.stable);
    this.timer = null;
    this.retryAt = null;
    this.stable = null;
  }

  private open(): void {
    // Fire-and-forget: minting the URL is a signature, so it is async, and
    // every caller of `open` is a scheduling decision that has already been
    // made (a first connect, or a backoff timer firing). Awaiting them all
    // would turn `connect`, `disconnect` and the retry path async for a few
    // milliseconds of ed25519.
    //
    // `opening` is set HERE, synchronously, and not inside `openAsync` — the
    // whole point is to be true before the first `await`, which is what makes
    // `connect`'s guard hold across it.
    if (this.opening) return;
    this.opening = true;
    void this.openAsync();
  }

  private async openAsync(): Promise<void> {
    let url: string;
    try {
      url = await this.deps.url();
    } catch (e) {
      // Cannot even address the vault. Treated as an ordinary drop so the
      // backoff applies: the usual cause is a device whose identity is not
      // loaded yet, which the next attempt fixes.
      //
      // Cleared BEFORE `handleClose`, which schedules the retry that will call
      // `open` again.
      this.opening = false;
      this.deps.warn?.(`Ctrl Notes: could not build the sync url: ${String(e)}`);
      this.handleClose();
      return;
    }
    // From here to `this.socket = socket` there is no `await`, so no other
    // caller can observe the gap this flag exists to cover.
    this.opening = false;
    if (!this.wanted) return; // `disconnect()` happened while we were signing.

    const socket = this.deps.createSocket(url);
    this.socket = socket;
    this.ready = false;
    this.awaitingReadyAfterHello = false;

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.onMessage(socket, event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      if (event?.code === SERVICE_RESTART_CLOSE_CODE) this.restarting(socket);
      else this.handleClose();
    };
    socket.onerror = () => {
      // Every runtime this plugin targets (desktop Electron, the mobile WebView) also
      // fires `onclose` for a transport error, so there is nothing further to do here —
      // this exists only so a caller that sets `onerror` on the underlying socket does not
      // find it silently unhandled.
    };
  }

  private async onMessage(socket: SocketLike, raw: unknown): Promise<void> {
    // **Binary frames are CONTENT, and dropping them is not an option.**
    // Until the vault grew `Down::Blob` nothing downward was ever binary, and
    // this method's `typeof raw === "string" ? … : null` discarded anything
    // that was not a string — silently, so a missing frame looked exactly like
    // a vault that had stopped sending. The bytes following a `blob` header
    // arrive here, and go straight to whoever is awaiting that sha.
    if (typeof raw !== "string") {
      const bytes = await asBytes(raw);
      if (bytes !== null) this.deps.onBytes?.(bytes);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Not a frame this build can read at all.
    }
    if (parsed === null) return;

    if (!this.ready && !this.awaitingReadyAfterHello) {
      await this.onFirstFrame(socket, parsed);
      return;
    }

    let down: Down | null;
    try {
      down = readDownFrame(parsed, this.deps.warn);
    } catch (e) {
      // Only a version mismatch on a `challenge` frame propagates past `readDownFrame`,
      // and the one `challenge` this connection ever gets was already consumed above —
      // unreachable in practice, but a real refusal rather than a swallowed one on
      // principle, matching every other terminal path in this file.
      this.terminal(socket, e instanceof Error ? e.message : String(e));
      return;
    }
    if (down === null) return; // An unrecognised frame TYPE — `readDownFrame` already warned.

    if (down.type === "ready") {
      this.ready = true;
      this.awaitingReadyAfterHello = false;
      this.armStable();
    } else if (down.type === "closing") {
      this.deps.onFrame(down);
      // The two texts first, because they choose HOW to retry and both are `later` on the
      // wire; then the field alone decides WHETHER to (this module's header).
      if (isRestartClosing(down.reason)) {
        this.restarting(socket);
      } else if (isIdleClosing(down.reason)) {
        this.parked(socket);
      } else if (down.retry === "never") {
        this.terminal(socket, this.closingMessage(down.reason));
      } else {
        // The vault's own words, not `closingMessage`'s: the vault-id diagnosis is for a
        // refusal a human has to act on, and a device on its way back is not one. Rendered
        // as `the vault said "…"` (`status.ts`), it would put this plugin's words in the
        // vault's mouth.
        this.resumable(socket, down.reason);
      }
      return;
    }
    this.deps.onFrame(down);
  }

  /** The very first frame on any connection is always `challenge` (§8.5) — decoded
   * strictly, not through `readDownFrame`'s tolerant entry point. A server sending anything
   * else here, or a `wire_version` this build does not speak, is not a forward-compatible
   * addition to tolerate: it is the version handshake itself failing. */
  private async onFirstFrame(socket: SocketLike, parsed: unknown): Promise<void> {
    let down: Down;
    try {
      down = decodeDown(parsed);
    } catch (e) {
      this.terminal(socket, e instanceof Error ? e.message : String(e));
      return;
    }
    if (down.type !== "challenge") {
      this.terminal(socket, `expected a challenge first, got "${down.type}"`);
      return;
    }
    // Nit fix: set BEFORE awaiting `signChallenge`, not after. `signChallenge` is a real
    // async ed25519 call — milliseconds, but not zero — and a frame arriving during that
    // window (the vault's own handshake-timeout `Down::Closing`, on a slow signature) must
    // take the ordinary `closing` path here, not `onFirstFrame`'s "expected a challenge
    // first" branch, which would replace the vault's own reason with a confusing one and
    // skip `closingMessage`'s vault-id diagnosis entirely.
    this.awaitingReadyAfterHello = true;
    this.wireVersion = down.wire_version;
    await this.answerChallenge(socket, down.challenge);
  }

  private async answerChallenge(socket: SocketLike, challengeB64: string): Promise<void> {
    const challenge = fromBase64Url(challengeB64);
    // Rule 3: `this.deps.vaultId` is this device's own stored value, never anything read
    // off `down` — the challenge frame carries no vault id at all, on purpose.
    const signature = await this.deps.identity.signChallenge(this.deps.vaultId, challenge);
    const hello: Up = {
      type: "hello",
      // The challenge's own version, not this build's newest: see `wireVersion`.
      wire_version: this.wireVersion,
      device_id: this.deps.deviceId,
      signature,
      since_seq: this.ackedSeq > 0 ? this.ackedSeq : null,
    };
    // Sent directly on the raw socket: `this.send()` requires `this.ready`, which `hello`
    // itself is what earns.
    socket.send(encodeUp(hello));
  }

  private closingMessage(reason: string): string {
    if (!this.awaitingReadyAfterHello) return reason;
    // The one piece of diagnosis only this side can do — see this module's header.
    return `could not connect to vault "${this.deps.vaultId}": ${reason}`;
  }

  private armStable(): void {
    if (this.stable !== null) window.clearTimeout(this.stable);
    this.stable = window.setTimeout(() => {
      this.stable = null;
      this.retryMs = FIRST_RETRY_MS;
    }, STABLE_MS);
  }

  /** The vault said why (`closing`), or this build refused to speak what it heard (a
   * `wire_version` mismatch). Neither is a dropped connection, so this reports it and
   * stops — seeing `wanted` false, `handleClose`'s own retry path does nothing further. */
  private terminal(socket: SocketLike, message: string): void {
    this.clearTimers();
    if (this.socket === socket) {
      this.detach(socket);
      this.socket = null;
      this.ready = false;
    }
    this.wanted = false;
    socket.close();
    this.deps.onClosing(message, false);
  }

  /**
   * The vault closed this connection without saying `never` — `retry: "later"`, or no `retry`
   * at all from a vault older than the field (this module's header). Unlike `terminal`,
   * `wanted` stays true and a retry is scheduled with the SAME backoff an ordinary dropped
   * connection gets — `handleClose` is not called directly because this path already knows
   * why it closed and has its own message to report, but the retry itself is `handleClose`'s
   * own `scheduleRetry`.
   */
  private resumable(socket: SocketLike, message: string): void {
    this.clearTimers();
    if (this.socket === socket) {
      this.detach(socket);
      this.socket = null;
      this.ready = false;
    }
    socket.close();
    this.deps.onClosing(message, true);
    this.scheduleRetry();
  }

  /**
   * The vault is restarting for an update (this module's header). `retryMs` is deliberately
   * untouched — not doubled, not reset — so this close counts for nothing in the backoff:
   * the next genuine failure picks up exactly where the last one left it.
   *
   * `clearTimers` also cancels a pending `stable` reset, and that is the same rule: a
   * connection that had not yet earned forgiveness for an earlier failure does not earn it
   * by being restarted either. The reconnect re-arms it on its own `ready`.
   */
  private restarting(socket: SocketLike): void {
    this.clearTimers();
    if (this.socket === socket) {
      this.detach(socket);
      this.socket = null;
      this.ready = false;
    }
    socket.close();
    if (!this.wanted) return;
    this.deps.onRestarting?.();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.wanted) this.open();
    }, RESTART_RECONNECT_MS);
  }

  /**
   * The vault let go of an idle socket (this module's header). `wanted` goes false, as in
   * `terminal`, so nothing in this module reconnects on its own; `retryMs` is left alone,
   * unlike a drop, because a quiet connection is not a failing one.
   * `connect()` is the way back, and it resumes from `ackedSeq` like any other connection.
   */
  private parked(socket: SocketLike): void {
    this.clearTimers();
    if (this.socket === socket) {
      this.detach(socket);
      this.socket = null;
      this.ready = false;
    }
    this.wanted = false;
    socket.close();
    this.deps.onIdle?.();
  }

  private handleClose(): void {
    this.clearTimers();
    if (this.socket !== null) this.detach(this.socket);
    this.socket = null;
    this.ready = false;
    if (!this.wanted) return; // `disconnect()` or `terminal()` already gave this up on purpose.
    // A drop before the handshake even reached `ready` gets the same "try again shortly"
    // treatment as one after — the retry policy does not distinguish them.
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.timer !== null) return;
    const random = this.deps.random ?? Math.random;
    // Full jitter over [retryMs/2, retryMs) — an earlier prototype's reasoning: every connection
    // that dropped in the same second (a deploy, a network blip) must not retry in
    // lockstep. `retryMs` itself keeps its exact doubling; jittering the stored value
    // would make the ladder drift and `STABLE_MS`'s reset lose a value worth reasoning
    // about. Capped while work is outstanding (BI4, `retryWait`).
    const wait = retryWait(this.retryMs, random(), this.deps.hasWork?.() ?? false);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.armRetry(wait);
  }

  private armRetry(wait: number): void {
    this.retryAt = Date.now() + wait;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.retryAt = null;
      if (this.wanted) this.open();
    }, wait);
  }
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
