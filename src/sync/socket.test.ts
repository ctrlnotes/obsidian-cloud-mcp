// SyncSocket's tests. A fake socket, never a real one — these run in vitest with no vault, per
// the plan's own instruction.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Down, Up } from "../wire.ts";
import { encodeUp, MIN_WIRE_VERSION, WIRE_VERSION } from "../wire.ts";
import {
  IDLE_REASON,
  RESTART_RECONNECT_MS,
  SERVICE_RESTART_CLOSE_CODE,
  type SocketLike,
  SyncSocket,
  type SyncSocketDeps,
  VAULT_RESTART_REASON,
  WORK_RETRY_MAX_MS,
} from "./socket.ts";

// Fake timers leak into the next test on a failing assertion (settle.test.ts's own
// reasoning) — restore unconditionally rather than one `vi.useRealTimers()` per test.
afterEach(() => {
  vi.useRealTimers();
});

/** Past this module's own retry ceiling, comfortably — long enough that if a reconnect were
 * ever going to fire on its own, it would have by here. */
const PAST_EVERY_RETRY_CEILING_MS = 6 * 60_000;

/** More microtask turns than any handshake step in this file needs — cheap, and it means a
 * test never has to reason about exactly how many `.then`s an `await` costs. */
const flush = async (turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/** Everything a test needs to drive one connection: the frames it sent, and a way to hand
 * it a message or drop it, without a real WebSocket underneath. */
class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { readonly code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(down: unknown): void {
    this.onmessage?.({ data: JSON.stringify(down) });
  }
  drop(): void {
    this.onclose?.();
  }
  /** The server closed with a code, as a real `CloseEvent` reports it. */
  closeWith(code: number): void {
    this.onclose?.({ code });
  }

  /** The `Up` frames sent so far, decoded — every send in these tests is JSON text. */
  upFrames(): Up[] {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Up);
  }
}

const CHALLENGE_B64 = "AQID"; // base64url of [1, 2, 3]
const CHALLENGE_BYTES = new Uint8Array([1, 2, 3]);

const fakeIdentity = () => ({
  signChallenge: vi.fn(async (vaultId: string, challenge: Uint8Array) => {
    return `sig(${vaultId},${Array.from(challenge).join(".")})`;
  }),
});

/** A harness wiring one `SyncSocket` to sockets it can hand out and inspect one at a time. */
function harness(overrides: Partial<SyncSocketDeps> = {}, sinceSeq = 0) {
  const sockets: FakeSocket[] = [];
  const frames: Down[] = [];
  const closings: string[] = [];
  let restarts = 0;
  const identity = fakeIdentity();
  const deps: SyncSocketDeps = {
    url: async () => "wss://vault.example/v1/sync",
    vaultId: "vault-abc",
    deviceId: "device-1",
    identity,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onFrame: (down) => frames.push(down),
    onClosing: (message) => closings.push(message),
    onRestarting: () => {
      restarts++;
    },
    random: () => 0.5, // the midpoint of every jitter window — deterministic, not a corner
    ...overrides,
  };
  const socket = new SyncSocket(deps, sinceSeq);
  return {
    socket,
    sockets,
    frames,
    closings,
    identity,
    restarts: () => restarts,
  };
}

function latest(h: ReturnType<typeof harness>): FakeSocket {
  const t = h.sockets[h.sockets.length - 1];
  if (t === undefined) throw new Error("harness did not create a socket");
  return t;
}

/** Connects, answers the challenge, and delivers `ready`. Returns the transport the
 * handshake completed on, for a test that only cares what happens after. */
async function connected(h: ReturnType<typeof harness>, seq = 0): Promise<FakeSocket> {
  h.socket.connect();
  // The URL is minted asynchronously now — it carries a signed routing proof —
  // so the socket does not exist until a microtask has run.
  await flush();
  const t = latest(h);
  t.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
  await flush();
  t.emit({ type: "ready", seq });
  return t;
}

describe("SyncSocket", () => {
  /** **The guard `connect()` documents, across the `await` that mints the URL.** The URL
   * carries a signed routing proof (O6), so there is a window where a connect has been
   * decided but `this.socket` is still null. A second `connect()` in that window used to
   * pass the guard and open a SECOND socket, overwriting the first — which nothing then
   * closes, and which counts against the vault's per-device connection limit until it dies
   * on its own. */
  it("a second connect while the url is still being signed opens no second socket", async () => {
    const h = harness();
    h.socket.connect();
    h.socket.connect();
    h.socket.connect();
    await flush();
    expect(h.sockets).toHaveLength(1);
  });

  /** Same window, reached the other way: a retry timer has fired and its `open()` is
   * waiting on a signature when the caller calls `connect()`. Held open deliberately —
   * with a URL that resolves promptly the retry is finished before `connect()` runs and
   * this test cannot fail. */
  it("a connect during a retry's own signing window opens no second socket", async () => {
    vi.useFakeTimers();
    try {
      // EVERY held call is released, not just the last one. Collecting a single
      // resolver would leave a second in-flight `open()` waiting forever, and the
      // test would pass by never letting the bug happen.
      const held: Array<() => void> = [];
      let hold = false;
      const h = harness({
        url: async () => {
          if (hold) await new Promise<void>((r) => held.push(r));
          return "wss://vault.example/v1/sync";
        },
      });
      h.socket.connect();
      await flush();
      hold = true;
      latest(h).drop();
      await vi.advanceTimersByTimeAsync(2_000); // fires the retry; its url now hangs

      h.socket.connect(); // must not slip past the guard
      for (const r of held) r();
      await flush();

      expect(h.sockets).toHaveLength(2); // the first, and the retry's — not three
    } finally {
      vi.useRealTimers();
    }
  });

  it("the first frame is the challenge, before we send anything", async () => {
    const h = harness();
    h.socket.connect();
    await flush();
    expect(latest(h).sent).toHaveLength(0);
  });

  it("we answer with hello, signed for our own vault", async () => {
    const h = harness({}, 41);
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    await flush();

    expect(h.identity.signChallenge).toHaveBeenCalledWith("vault-abc", CHALLENGE_BYTES);
    const [hello] = t.upFrames();
    expect(hello).toEqual({
      type: "hello",
      wire_version: WIRE_VERSION,
      device_id: "device-1",
      signature: "sig(vault-abc,1.2.3)",
      since_seq: 41,
    });
  });

  it("a ready frame carries the cursor we resume from", async () => {
    const h = harness();
    await connected(h, 4821);
    expect(h.frames).toEqual([{ type: "ready", seq: 4821 }]);
  });

  it("a terminal closing frame is surfaced to the user, not retried forever", async () => {
    // **Test robustness.** `vi.useFakeTimers()` replaces the global
    // `setTimeout` only for timers created AFTER it runs — a real 500-1000ms retry timer
    // scheduled by a regressed `terminal()` BEFORE this line would be a real timer no fake
    // clock can reach, so the assertion below would pass whether or not a retry was
    // actually scheduled. Installed before `connect()`, like every other fake-timer case in
    // this file, it is a real test of "no retry was scheduled" rather than an accident of
    // where the clock was swapped in.
    vi.useFakeTimers();
    const h = harness();
    const t = await connected(h);
    t.emit({ type: "closing", reason: "this device's trust has been withdrawn", retry: "never" });
    await flush();

    expect(h.closings).toEqual(["this device's trust has been withdrawn"]);
    expect(t.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(PAST_EVERY_RETRY_CEILING_MS);
    expect(h.sockets).toHaveLength(1); // no reconnect was ever scheduled
  });

  /**
   * Before this, EVERY `closing` was terminal — including the two the vault
   * itself documents as self-healing (this module's header). A device revoked mid-session
   * would never reconnect; a device merely over the per-device connection cap, or too far
   * behind acknowledging, was stuck exactly the same way until Obsidian restarted.
   */
  it("a later closing retries with the ordinary backoff, not the user's attention", async () => {
    vi.useFakeTimers(); // before `connect()` — see the test above for why that matters.
    const h = harness();
    const t = await connected(h);
    t.emit({
      type: "closing",
      reason: "too far behind acknowledging; reconnect and resume from your last seq",
      retry: "later",
    });
    await flush();

    expect(h.closings).toEqual([
      "too far behind acknowledging; reconnect and resume from your last seq",
    ]);
    expect(t.closed).toBe(true);
    expect(h.sockets).toHaveLength(1); // not immediate

    await vi.advanceTimersByTimeAsync(2_000); // past the first backoff window
    expect(h.sockets).toHaveLength(2); // the retry fired, exactly like an ordinary drop
  });

  it("the per-device connection cap is retried too", async () => {
    vi.useFakeTimers();
    const h = harness();
    const t = await connected(h);
    t.emit({
      type: "closing",
      reason: "too many connections open for this device",
      retry: "later",
    });
    await flush();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
  });

  /**
   * Bulk-ingest design BI1: a vault older than the `retry` field sends none, and that reads as
   * `later` — including for a reason this build used to treat as terminal. Retrying against a
   * vault that will refuse again costs one request per backoff step; giving up against one
   * that would have recovered costs the whole sync.
   *
   * **Proven able to fail** by decoding an absent `retry` as `never`: no second socket.
   */
  it("a closing with no retry field (an older vault) retries with backoff", async () => {
    vi.useFakeTimers();
    const h = harness();
    const t = await connected(h);
    t.emit({ type: "closing", reason: "this device's trust has been withdrawn" });
    await flush();

    expect(h.closings).toEqual(["this device's trust has been withdrawn"]);
    expect(t.closed).toBe(true);
    expect(h.sockets).toHaveLength(1); // not immediate
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
  });

  /**
   * The §1 case of the bulk-ingest design, exactly: a busy vault answered the hello with
   * `handshake timed out`, this module read the text as terminal, the socket closed, and with
   * no traffic Fly suspended the vault in the middle of a first sync that never finished.
   *
   * **Proven able to fail** by restoring the text-matched resumable set: the closing is
   * terminal and no second socket opens.
   */
  it('"handshake timed out" with retry later retries rather than stopping', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    await flush();
    t.emit({ type: "closing", reason: "handshake timed out", retry: "later" });
    await flush();

    expect(h.closings).toEqual(['could not connect to vault "vault-abc": handshake timed out']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
  });

  /**
   * BI4: while this device has work outstanding, a reconnect waits at most
   * `WORK_RETRY_MAX_MS`, however far the backoff has climbed — so the vault never sits quiet
   * long enough to suspend in the middle of an upload. `random` is 1, the top of every jitter
   * window, so an uncapped wait would be the whole `retryMs`.
   *
   * **Proven able to fail** by ignoring `hasWork` in `scheduleRetry`: the sixth failure waits
   * 32 s and the socket count falls behind.
   */
  it("with work outstanding a reconnect waits at most 30 s", async () => {
    vi.useFakeTimers();
    const h = harness({ hasWork: () => true, random: () => 1 });
    h.socket.connect();
    await flush();
    for (let failure = 1; failure <= 10; failure++) {
      latest(h).drop();
      await vi.advanceTimersByTimeAsync(WORK_RETRY_MAX_MS);
      await flush();
      expect(h.sockets).toHaveLength(failure + 1);
    }
  });

  /** The control for the case above: the same ladder without work climbs past 30 s. */
  it("without work outstanding the backoff climbs past 30 s as before", async () => {
    vi.useFakeTimers();
    let work = false;
    const h = harness({ hasWork: () => work, random: () => 1 });
    h.socket.connect();
    await flush();
    // 1, 2, 4, 8, 16 s: each inside the cap.
    for (let failure = 1; failure <= 5; failure++) {
      latest(h).drop();
      await vi.advanceTimersByTimeAsync(WORK_RETRY_MAX_MS);
      await flush();
    }
    expect(h.sockets).toHaveLength(6);
    latest(h).drop(); // retryMs is now 32 s
    await vi.advanceTimersByTimeAsync(WORK_RETRY_MAX_MS);
    await flush();
    expect(h.sockets).toHaveLength(6);
    // And the cap is read when the retry is SCHEDULED, so work arriving later does not
    // shorten a wait already running: the next socket comes at 32 s.
    work = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.sockets).toHaveLength(7);
  });

  it("never signs a vault id the server put on the challenge frame", async () => {
    // Rule 3 (this module's own header): the challenge frame carries no vault id on
    // purpose, so a vault id appearing on the frame anyway must never be trusted — this is
    // the adversarial half; "we answer with hello, signed for our own vault" above only
    // shows the plugin signs its own id when nothing else is on offer, which a broken
    // plugin that blindly trusted an attacker-supplied field would also do.
    const h = harness({ vaultId: "vault-mine" });
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({
      type: "challenge",
      wire_version: WIRE_VERSION,
      challenge: CHALLENGE_B64,
      vault_id: "vault-attacker",
    });
    await flush();

    expect(h.identity.signChallenge).toHaveBeenCalledWith("vault-mine", CHALLENGE_BYTES);
  });

  it("a mismatched vault id names itself in the closing message", async () => {
    // Rule 3, and the reason `terminal`'s message differs from the raw reason: the vault
    // cannot say WHY a signature failed to verify without leaking whether a device id
    // exists, so it answers every handshake failure with the same opaque reason. Only the
    // client knows which vault id it signed for.
    const h = harness({ vaultId: "vault-wrong" });
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    await flush();
    t.emit({ type: "closing", reason: "not authorised", retry: "never" });
    await flush();

    expect(h.closings).toEqual(['could not connect to vault "vault-wrong": not authorised']);
  });

  /**
   * **Nit fix.** `awaitingReadyAfterHello` used to flip to `true` only AFTER `signChallenge`
   * resolved — a real async ed25519 call, milliseconds but not zero. A `closing` arriving in
   * that window (the vault's own handshake-timeout answer, on a slow signature) used to hit
   * `onFirstFrame`'s strict decoder again, which only understands `challenge` there, so it
   * replaced the vault's actual reason with "expected a challenge first, got \"closing\"" —
   * and skipped the vault-id diagnosis the test above exists to prove.
   */
  it("a frame arriving while the signature is still pending is not misreported", async () => {
    const h = harness({ vaultId: "vault-mine" });
    h.identity.signChallenge.mockImplementation(() => new Promise(() => {})); // never settles
    h.socket.connect();
    await flush();
    const t = latest(h);

    t.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    // Still inside the pending `signChallenge` call — nothing has awaited past it yet.
    t.emit({ type: "closing", reason: "handshake timed out" });
    await flush();

    expect(h.closings).toEqual(['could not connect to vault "vault-mine": handshake timed out']);
  });

  it("a closing frame received well after the handshake carries no vault-id framing", async () => {
    // Only a failure that arrives WHILE we are waiting on our own hello is a plausible
    // auth mismatch — one that arrives later (trust revoked, too many connections) is not,
    // and naming a vault id in that message would misdiagnose it.
    const h = harness();
    const t = await connected(h);
    t.emit({
      type: "closing",
      reason: "too many connections open for this device",
      retry: "later",
    });
    await flush();

    expect(h.closings).toEqual(["too many connections open for this device"]);
  });

  it("an unknown wire_version refuses and says which to speak", async () => {
    const h = harness();
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({ type: "challenge", wire_version: 99, challenge: CHALLENGE_B64 });

    expect(h.closings).toHaveLength(1);
    expect(h.closings[0]).toContain("version 99");
    // Against WIRE_VERSION rather than a literal: the number moves whenever a
    // frame changes shape, and a test that hardcodes it fails for the wrong
    // reason every time it does.
    expect(h.closings[0]).toContain(`speaks versions ${MIN_WIRE_VERSION} to ${WIRE_VERSION}`);
    expect(t.closed).toBe(true);
    expect(t.sent).toHaveLength(0); // never answered a version it does not speak
  });

  /**
   * A release-11 vault speaks 3 and admits only a v3 hello (`vault::sync::pure::admit`
   * compares exactly). Answering in this build's newest version would lock this plugin out of
   * every vault not yet moved to a v4 release.
   *
   * **Proven able to fail** by sending `WIRE_VERSION` in `hello`: the frame says 4.
   */
  it("hello answers with the version the challenge named (3 against an older vault)", async () => {
    const h = harness();
    h.socket.connect();
    await flush();
    const t = latest(h);
    t.emit({ type: "challenge", wire_version: 3, challenge: CHALLENGE_B64 });
    await flush();

    const [hello] = t.upFrames();
    expect(hello).toMatchObject({ type: "hello", wire_version: 3 });
    expect(h.closings).toEqual([]);
  });

  it("a dropped socket reconnects with backoff, not immediately", async () => {
    vi.useFakeTimers();
    const h = harness();
    await connected(h);
    expect(h.sockets).toHaveLength(1);

    latest(h).drop();
    expect(h.sockets).toHaveLength(1); // not immediate

    await vi.advanceTimersByTimeAsync(600);
    expect(h.sockets).toHaveLength(1); // still within the backoff window

    await vi.advanceTimersByTimeAsync(600);
    expect(h.sockets).toHaveLength(2); // the retry fired
  });

  /**
   * "Sync now" during a drop's backoff. **Proven able to fail** by making `reconnectNow`
   * return `false` without opening: the second socket waits out the backoff.
   */
  it("reconnectNow skips a pending backoff, and does nothing while connected", async () => {
    vi.useFakeTimers();
    const h = harness();
    await connected(h);
    expect(h.socket.reconnectNow()).toBe(false); // open and ready: nothing to skip
    expect(h.sockets).toHaveLength(1);

    latest(h).drop();
    expect(h.socket.reconnectNow()).toBe(true);
    await flush();
    expect(h.sockets).toHaveLength(2); // at once, not after the backoff
    expect(h.socket.reconnectNow()).toBe(false); // already connecting

    await vi.advanceTimersByTimeAsync(PAST_EVERY_RETRY_CEILING_MS);
    expect(h.sockets).toHaveLength(2); // the skipped timer is gone, not merely late
  });

  it("reconnecting sends the last ACKED seq, not the last seen", async () => {
    vi.useFakeTimers();
    const h = harness({}, 0);
    const first = await connected(h, 0);

    // Two events arrive — the highest seq this device has SEEN is now 10 — but only 5 is
    // ever acknowledged, the way a caller that applied the first and is still working on
    // the second would report it.
    first.emit({ type: "event", seq: 5, kind: "put", path: "a.md", sha: "s", at_ms: 1 });
    first.emit({ type: "event", seq: 10, kind: "put", path: "b.md", sha: "s", at_ms: 2 });
    h.socket.noteAck(5);

    first.drop();
    await vi.advanceTimersByTimeAsync(2_000);
    const second = latest(h);
    expect(second).not.toBe(first);
    second.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    await flush();

    const [hello] = second.upFrames();
    expect((hello as { since_seq: number | null }).since_seq).toBe(5);
  });

  it("send refuses to leave the handshake early", async () => {
    const h = harness();
    h.socket.connect();
    await flush();
    expect(() => h.socket.send({ type: "ack", seq: 1 })).toThrow();
    expect(() => h.socket.sendBinary(new Uint8Array())).toThrow();
  });

  it("sends once ready, using encodeUp's own wire shape", async () => {
    const h = harness();
    const t = await connected(h, 0);
    h.socket.send({ type: "ack", seq: 7 });
    expect(t.sent[t.sent.length - 1]).toBe(encodeUp({ type: "ack", seq: 7 }));
  });

  /**
   * `wire.test.ts` already covers `readDownFrame` returning `null` for an
   * unrecognised frame TYPE, forward-compatibly — but nothing at THIS layer checked that the
   * connection actually survives one. `onMessage`'s `if (down === null) return;` is the line
   * that matters, and a regression turning that into `this.terminal(...)` would pass every
   * existing test here, since none of them ever put an unknown-typed frame on a LIVE
   * connection.
   */
  it("an unknown down frame is skipped, and the connection carries on", async () => {
    const h = harness();
    const t = await connected(h);

    t.emit({ type: "telemetry", whatever: 1 });
    await flush();

    expect(h.closings).toEqual([]);
    expect(t.closed).toBe(false);
    expect(h.socket.isReady).toBe(true);

    // And it is still usable: a real frame right after still reaches `onFrame`.
    t.emit({ type: "event", seq: 1, kind: "put", path: "a.md", sha: "s", at_ms: 1 });
    await flush();
    expect(h.frames[h.frames.length - 1]).toEqual({
      type: "event",
      seq: 1,
      // The vault in this test omits `from` — an older one legitimately does,
      // and the decoder fills it in rather than refusing the frame.
      from: null,
      kind: "put",
      path: "a.md",
      sha: "s",
      at_ms: 1,
    });
  });

  /**
   * Staged rollout design §5: a vault restarting for an update closes with 1012. That is
   * reported as a restart (the status line says "updating"), not as a closing, and the
   * reconnect waits a FIXED `RESTART_RECONNECT_MS` rather than the backoff.
   */
  it("a 1012 close reports a restart and reconnects after the fixed delay", async () => {
    vi.useFakeTimers(); // before `connect()` — see the terminal-closing test for why.
    const h = harness();
    await connected(h);

    latest(h).closeWith(SERVICE_RESTART_CLOSE_CODE);

    expect(h.restarts()).toBe(1);
    expect(h.closings).toEqual([]); // not a refusal, and not a disconnection notice
    expect(latest(h).closed).toBe(true);

    await vi.advanceTimersByTimeAsync(RESTART_RECONNECT_MS - 1);
    expect(h.sockets).toHaveLength(1); // fixed delay, not the 500-1000ms first backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
  });

  /**
   * The restart counts for nothing in the backoff. One ordinary drop takes `retryMs` from
   * 1s to 2s; after the restart, the next ordinary drop must wait 1.5s (2s at the jitter
   * midpoint) — not 3s, which is a restart counted as a failure (doubled to 4s), and not
   * 0.75s, which is a restart treated as proof of health (reset to 1s).
   */
  it("a 1012 close leaves the backoff exactly where it was", async () => {
    vi.useFakeTimers();
    const h = harness();
    await connected(h);

    latest(h).drop(); // an ordinary failure: waits 750ms, retryMs now 2s
    await vi.advanceTimersByTimeAsync(750);
    expect(h.sockets).toHaveLength(2);
    latest(h).emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
    await flush();
    latest(h).emit({ type: "ready", seq: 0 }); // up, but short of STABLE_MS

    latest(h).closeWith(SERVICE_RESTART_CLOSE_CODE);
    await vi.advanceTimersByTimeAsync(RESTART_RECONNECT_MS);
    expect(h.sockets).toHaveLength(3);

    latest(h).drop(); // the vault is still coming up
    await vi.advanceTimersByTimeAsync(1_499);
    expect(h.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(4);
  });

  /**
   * The vault sends `closing` with its restart reason BEFORE the 1012. An unrecognised
   * `closing` is terminal and detaches the socket, so without this the 1012 is never seen
   * and every routine update stops sync until Obsidian restarts.
   */
  it("the vault's restart closing frame is a restart, not a terminal closing", async () => {
    vi.useFakeTimers();
    const h = harness();
    const t = await connected(h);

    t.emit({ type: "closing", reason: VAULT_RESTART_REASON });
    await flush();
    t.closeWith(SERVICE_RESTART_CLOSE_CODE); // what the vault does next

    expect(h.restarts()).toBe(1); // once, not once per signal
    expect(h.closings).toEqual([]);
    expect(t.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RESTART_RECONNECT_MS);
    expect(h.sockets).toHaveLength(2);
  });

  it("any other close code is an ordinary drop, with the ordinary backoff", async () => {
    vi.useFakeTimers();
    const h = harness();
    await connected(h);

    latest(h).closeWith(1011); // Internal Error — adjacent to 1012, and not a restart

    expect(h.restarts()).toBe(0);
    await vi.advanceTimersByTimeAsync(749);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2); // the first backoff step, not the restart delay
  });

  /**
   * Vault-sleep design VS1, VS4. The vault closes a silent socket so its machine can
   * suspend; the plugin parks. Were this string not recognised it would be `terminal`: a
   * Notice for every 90 s of quiet, and no sync until Obsidian restarted.
   */
  describe("an idle closing parks rather than failing", () => {
    const idleHarness = () => {
      let idles = 0;
      const h = harness({
        onIdle: () => {
          idles++;
        },
      });
      return { ...h, idles: () => idles };
    };

    it("is reported through onIdle, never onClosing, and closes the socket", async () => {
      const h = idleHarness();
      const t = await connected(h);

      t.emit({ type: "closing", reason: IDLE_REASON });
      await flush();
      t.closeWith(1000); // what the vault does next

      expect(h.idles()).toBe(1);
      expect(h.closings).toEqual([]);
      expect(h.restarts()).toBe(0);
      expect(t.closed).toBe(true);
      expect(h.socket.isReady).toBe(false);
    });

    it("schedules no reconnect of its own", async () => {
      vi.useFakeTimers();
      const h = idleHarness();
      const t = await connected(h);

      t.emit({ type: "closing", reason: IDLE_REASON });
      await flush();
      t.closeWith(1000);
      await vi.advanceTimersByTimeAsync(PAST_EVERY_RETRY_CEILING_MS);

      expect(h.sockets).toHaveLength(1);
    });

    it("connect() afterwards resumes from the last acked seq", async () => {
      const h = idleHarness();
      const t = await connected(h, 7);
      h.socket.noteAck(7);

      t.emit({ type: "closing", reason: IDLE_REASON });
      await flush();
      h.socket.connect();
      await flush();
      const second = latest(h);
      expect(second).not.toBe(t);
      second.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: CHALLENGE_B64 });
      await flush();

      const hello = second.upFrames().find((f) => f.type === "hello");
      expect(hello).toMatchObject({ type: "hello", since_seq: 7 });
    });

    it("a drop on the reconnect after a park retries on the ordinary backoff", async () => {
      vi.useFakeTimers();
      const h = idleHarness();
      const t = await connected(h);

      t.emit({ type: "closing", reason: IDLE_REASON });
      await flush();
      h.socket.connect();
      await flush();
      latest(h).drop(); // a real failure, before any handshake

      await vi.advanceTimersByTimeAsync(749);
      expect(h.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(3); // the first backoff step
    });
  });
});
