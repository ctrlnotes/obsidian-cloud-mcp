// The plugin shell's own tests — not an earlier prototype's `main.test.ts`, which
// drove a device-code pairing flow and a batched HTTP exchange this plugin does not have.
// Socket handshake mechanics and the outbound queue already have their
// own thorough suites; this file only exercises what belongs to the SHELL: lifecycle
// safety around `onunload`, the settle → derive → push wiring, and the honest "unpaired
// means untouched" default.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmAdoption } from "./adopt.ts";
import { DeviceIdentity, decodeBase64Url, SECRET_ID } from "./device.ts";
import CtrlNotesPlugin from "./main.ts";
import * as pairingIntent from "./pairing-intent.ts";
import { PAIRED_ACTIONS } from "./protocol.ts";
import { CtrlNotesSettingsTab } from "./settings-tab.ts";
import { contentHash } from "./sync/hash.ts";
import { MAX_IDLE_WAKES, SIGNAL_POLL_MS, SIGNAL_TIMEOUT_MS } from "./sync/park.ts";
import type { Pump } from "./sync/pump.ts";
import { QUIET_MS } from "./sync/settle.ts";
import { IDLE_REASON, WORK_RETRY_MAX_MS } from "./sync/socket.ts";
import { describeStatus, UPDATING_TEXT } from "./sync/status.ts";
import {
  FakeWebSocket,
  fakeApp,
  fireVaultEvent,
  load,
  manifest,
  readGates,
  removedPaths,
  settleMicrotasks,
  stubSystemBrowser,
  stubWebSocket,
  unloadAll,
} from "./testing/fake-host.ts";
import {
  commands,
  fakeDocument,
  fireDomEvent,
  notices,
  noticeText,
  Platform,
  protocolHandlers,
  requestUrlCalls,
  requestUrlHangs,
  requestUrlHeld,
  requestUrlQueue,
} from "./testing/fake-obsidian.ts";
import { WIRE_VERSION } from "./wire.ts";

afterEach(() => {
  unloadAll();
  requestUrlQueue.length = 0;
  requestUrlCalls.length = 0;
  requestUrlHangs.next = 0;
  requestUrlHeld.next = 0;
  requestUrlHeld.answers.length = 0;
  Platform.isMobile = false;
  notices.length = 0;
  protocolHandlers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * How long `vi.waitFor` may keep re-checking a condition before the test fails.
 *
 * **Wait for the condition, never for a duration.** These tests run real timers (see
 * `settleMicrotasks`): a signature, a hash and a settle all complete on the event loop, and
 * how long that takes is a property of the machine, not of the code. A fixed sleep followed
 * by a positive assertion was therefore a guess about machine load, and under load it
 * guessed wrong — measured 2026-09-22 with 30 busy-loop processes on 12 cores, the suite
 * failed a different test on a third of runs, each one a socket, frame or status asserted
 * a few milliseconds before it arrived. The sleeps that remain give a NEGATIVE assertion
 * ("nothing else was sent") its quiet window; the positive ones wait for what they assert.
 *
 * 20 s is well inside the 30 s hang guard in `vitest.config.ts`, and an idle machine meets
 * every one of these in milliseconds.
 */
const UNTIL = { timeout: 20_000, interval: 20 } as const;

/** The real `setTimeout`, captured before any case fakes it — for `untilRealClock`. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Wait for `check` to pass on the REAL clock, while timers are faked.
 *
 * **Not `vi.waitFor`**, which advances faked timers by its interval on every check. A case
 * that fakes timers to keep a backoff from firing would have that very backoff fired for it,
 * and pass whether or not the thing it tests did anything — measured: both cases that use
 * this passed with their guarded code removed until they did.
 */
const untilRealClock = async (check: () => void): Promise<void> => {
  const deadline = Date.now() + UNTIL.timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((resolve) => realSetTimeout(resolve, UNTIL.interval));
    }
  }
};

/** Answer the handshake on a freshly opened socket up through `ready` — everything Task
 * 9's `SyncSocket` needs before `main.ts` will send anything on it. */
const bringUp = async (ws: FakeWebSocket, seq = 0): Promise<void> => {
  ws.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: "AAAA" });
  // `identity.signChallenge` is a real async ed25519 call: wait for the `hello` it signs,
  // not for a guess at how long signing takes.
  await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "hello")).toBe(true), UNTIL);
  ws.emit({ type: "ready", seq });
  await settleMicrotasks();
};

describe("the plugin does nothing at all until it is paired", () => {
  it("opens no socket and makes no request for an unconfigured plugin", async () => {
    stubWebSocket();
    await load({ "note.md": "hi" }); // No controlplaneOrigin, vaultId or deviceId.

    fireVaultEvent("create", "note.md");
    fireVaultEvent("modify", "note.md");

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(requestUrlCalls).toHaveLength(0);
  });

  it("still opens no socket with a vault id and origin set but no device id yet", async () => {
    stubWebSocket();
    await load(
      { "note.md": "hi" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: null },
    );
    fireVaultEvent("modify", "note.md");

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(requestUrlCalls).toHaveLength(0);
  });
});

describe("a case-only rename, on the filesystems most users run", () => {
  /**
   * **APFS and NTFS are case-insensitive, so `exists("notes/foo.md")` answers
   * true while only `notes/Foo.md` is there.** The vault echoes this device's
   * own rename back, and the plugin asks whether the source is still present
   * to tell an echo from a rename it has yet to perform. Asked
   * case-INSENSITIVELY, a `foo.md` → `Foo.md` rename reports its own source as
   * present, and the branch that assumes so cannot apply it.
   *
   * The fake adapter models a case-insensitive filesystem unless `sensitive`
   * is passed, so **this fails if `main.ts` drops that argument** — which is
   * the only thing standing between this fix and doing nothing on macOS and
   * Windows. Found by the review of #158.
   */
  it("applies the echo of a case-only rename rather than stalling the cursor", async () => {
    stubWebSocket();
    const body = "same bytes\n";
    const sha = await contentHash(body);
    // The rename has already happened on this device — the vault is echoing it
    // back — so only the NEW spelling is on disk.
    await load(
      { "notes/Foo.md": body },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    ws.sent.length = 0;

    ws.emit({
      type: "event",
      seq: 42,
      kind: "rename",
      path: "notes/Foo.md",
      from: "notes/foo.md",
      sha,
      at_ms: 0,
    });
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "ack")).toBe(true), UNTIL);

    // The ack is the whole point: without it the cursor stops here and every
    // reconnect replays this event.
    expect(ws.upFrames().filter((f) => f.type === "ack")).toEqual([{ type: "ack", seq: 42 }]);
  });
});

describe("an edit storm produces one send, not one per keystroke", () => {
  it("settles a burst of modify events into a single put", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hello" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws); // Real timers: a device signature is a real async ed25519 call.
    ws.sent.length = 0; // Drop the `hello` recorded before the handshake completed.

    // Real timers throughout, deliberately, not `vi.useFakeTimers()` + `advanceTimersByTimeAsync`:
    // the settle this fires also runs `deriveChanges`, which hashes with `crypto.subtle` —
    // the same real, thread-pool-backed completion `bringUp`'s own comment names, so it
    // needs the same real wall-clock wait `settleMicrotasks` gives it, not a simulated one.
    for (let i = 0; i < 5; i++) fireVaultEvent("modify", "note.md");
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const puts = ws.upFrames().filter((f) => f.type === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("note.md");
    void plugin;
  });
});

describe("attachments", () => {
  /**
   * A desktop device sends them.
   *
   * This asserted the opposite — "never derives or sends a put for a non-text file" —
   * while `apply_upload` ran `String::from_utf8` over every completed upload and had no
   * blob branch. Deriving, reading, hashing and streaming an attachment's full bytes only
   * to have the vault refuse each one was wasted work and a permanently non-zero refusal
   * counter, so `main.ts`'s `attachments` getter held every device back.
   *
   * `Op::PutBytes` is the path that was missing, so the getter is `!Platform.isMobile`
   * again and this asserts what a user expects: an image added to the vault goes up.
   *
   * **Proven able to fail** by returning `false` from that getter: no `put` is sent.
   */
  it("are derived and sent on a desktop device", async () => {
    stubWebSocket();
    const plugin = await load(
      { "img.png": "pretend png bytes" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    ws.sent.length = 0;

    fireVaultEvent("create", "img.png");
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const puts = ws.upFrames().filter((f) => f.type === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("img.png");
    void plugin;
  });
});

describe("unloading closes the socket and cancels pending work", () => {
  it("closes the open connection", async () => {
    stubWebSocket();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    plugin.unload();

    expect(ws.closed).toBe(true);
  });

  it("cancels the settle timer, so a pending edit does not fire after unload", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hello" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws); // Real timers, for the same reason the test above needs them.
    ws.sent.length = 0;

    vi.useFakeTimers();
    fireVaultEvent("modify", "note.md"); // Arms the settler's QUIET_MS timer.
    plugin.unload();
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1_000);

    expect(ws.upFrames().filter((f) => f.type === "put")).toHaveLength(0);
  });
});

describe("a late retrieval resolving after unload touches nothing", () => {
  it("does not redeem, notify or persist once the plugin is gone", async () => {
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );

    // `requestUrl` has no abort — the retrieval's response can land after `onunload`
    // regardless of the pairing signal, so this is held back and resolved deliberately
    // AFTER unload rather than relying on timing.
    let resolveRetrieval: ((value: pairingIntent.Settled) => void) | undefined;
    const retrieveSpy = vi.spyOn(pairingIntent, "retrieveWhenBound").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetrieval = resolve;
        }),
    );

    requestUrlQueue.push({
      status: 201,
      json: { intent_id: "intent-1", expires_at: Date.now() + 600_000 },
    });
    const pairingPromise = plugin.startPairing("My Laptop");
    // Let the intent hop resolve; the poll is then in flight.
    await vi.waitFor(() => expect(retrieveSpy).toHaveBeenCalled(), UNTIL);

    expect(retrieveSpy).toHaveBeenCalled();
    plugin.unload();

    // The "late" response: bound, with an assertion a live plugin would offer to adopt.
    resolveRetrieval?.({
      status: "bound",
      pairing: { pairingId: "pai_1", vaultId: "vault-1", assertion: "pra2.abc" },
    });
    await pairingPromise;
    await settleMicrotasks();

    // The gate is never even opened, so the user is not asked to consent by a plugin that
    // is already gone — and nothing is redeemed or written.
    expect(requestUrlCalls.filter((c) => c.url.includes("/redeem"))).toHaveLength(0);
    expect(await plugin.loadData()).toMatchObject({ vaultId: "", deviceId: null });
  });
});

describe("a terminal closing during an outstanding push does not stop syncing forever", () => {
  /**
   * **Blocker fix.** `disconnectSyncing()` used to drop the `Pump` holding an outstanding
   * `push()` with no reply ever coming — that promise stayed unsettled forever, so
   * `pushTouched`'s `await` never returned, `this.syncing` latched `true` for the rest of
   * this instance's life, and every later edit was a silent no-op (`this.syncing` re-arms
   * the settler and returns rather than deriving anything). `Pump.abandon()` (called from
   * `disconnectSyncing`) rejects that promise instead, and `pushTouched`'s `catch` puts the
   * whole unsent tail of that settle's batch back onto `this.touched` rather than only the
   * one change that happened to be at the front.
   */
  it("re-derives and resends everything a mid-push revocation left behind", async () => {
    // Two real settle windows (`QUIET_MS` each, real timers throughout — the same reason
    // `bringUp`'s own comment gives) comfortably exceed vitest's default per-test timeout.
    stubWebSocket();
    const plugin = await load(
      { "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" },
      {
        controlplaneOrigin: "https://cp.test",
        webAppOrigin: "https://app.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws0 = FakeWebSocket.instances[0];
    expect(ws0).toBeDefined();
    if (ws0 === undefined) return;
    await bringUp(ws0);
    ws0.sent.length = 0;

    fireVaultEvent("create", "a.md");
    fireVaultEvent("create", "b.md");
    fireVaultEvent("create", "c.md");
    await vi.waitFor(() => expect(ws0.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    // Single-flight (`pump.ts`'s own header): only the FIRST change has actually been sent
    // when the vault revokes this device — its reply never arrives, and `b.md`/`c.md` were
    // derived but never even handed to `pump.push()`.
    const putsBefore = ws0.upFrames().filter((f) => f.type === "put");
    expect(putsBefore).toHaveLength(1);
    expect(putsBefore[0]?.path).toBe("a.md");

    ws0.emit({ type: "closing", reason: "this device's trust has been withdrawn", retry: "never" });
    await settleMicrotasks();

    // Re-pairing is the only path back to `startSyncing` after a terminal closing
    // (`socket.ts`'s own header) — this is also the finding's own probe shape.
    await plugin.disconnect();
    stubSystemBrowser();
    plugin.confirmAdoption = async () => true;
    requestUrlQueue.push({
      status: 201,
      json: { intent_id: "intent-1", expires_at: Date.now() + 600_000 },
    });
    requestUrlQueue.push({ status: 200, json: { challenge: "A".repeat(43) } });
    requestUrlQueue.push({
      status: 200,
      json: { state: "bound", pairing_id: "pai_1", vault_id: "vault-1", assertion: "pra2.abc" },
    });
    queueRefreshAfterTap();
    requestUrlQueue.push({ status: 201, json: { device_id: "dev-2" } });
    await plugin.startPairing("My Laptop");
    // Adoption opens the socket, and its URL is minted asynchronously (a signed
    // routing proof, O6), so the transport appears a microtask later.
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);

    const ws1 = FakeWebSocket.instances[1];
    expect(ws1).toBeDefined();
    if (ws1 === undefined) return;
    await bringUp(ws1);

    // The single-flight queue (`pump.ts`'s own header) only sends the NEXT change once the
    // vault has answered the last one — so proving `b.md`/`c.md` also make it out (not just
    // whichever one happens to be first) needs a vault on the other end that actually
    // replies to a `put` with `applied`, unlike every other case in this file.
    let seq = 1_000;
    const rawSend = ws1.send.bind(ws1);
    ws1.send = (data: string | Uint8Array) => {
      rawSend(data);
      if (typeof data === "string") {
        const frame = JSON.parse(data) as { type?: string; path?: string; sha?: string };
        if (frame.type === "put") {
          seq += 1;
          ws1.emit({ type: "applied", path: frame.path, seq, sha: frame.sha });
        }
      }
    };

    await vi.waitFor(
      () => expect(ws1.upFrames().filter((f) => f.type === "put")).toHaveLength(3),
      UNTIL,
    );
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const paths = ws1
      .upFrames()
      .filter((f) => f.type === "put")
      .map((f) => f.path)
      .sort();
    // `a.md` (re-dirtied when its abandoned push was rejected) plus `b.md` and `c.md`
    // (never sent at all before the closing) all make it out once this device is paired
    // again. Before the fix this array was empty, forever — `this.syncing` never unlatched.
    expect(paths).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("an inbound delete goes through trashLocal, never a permanent remove", () => {
  /**
   * `main.ts`'s own comment on this wiring calls it load-bearing: "a delete
   * this device should not have applied stays recoverable by the user." Nothing drove an
   * inbound `delete` down through `main.ts`'s real adapter wiring before this — the unit
   * tests exercise `VaultFiles.trash` directly, where the interface has no `remove` to
   * reach for at all, so the type system was doing the work up to that boundary and this is
   * exactly where the boundary ends.
   */
  it("trashes the local file rather than permanently deleting it", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "will be deleted remotely\n" },
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        // Synced, and unchanged since: a delete may trash only a file whose
        // bytes are still what the vault last had — anything else is an
        // unpushed edit, and edit beats delete.
        appOptions: {
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              hashes: { "note.md": await contentHash("will be deleted remotely\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    ws.emit({ type: "event", seq: 1, kind: "delete", path: "note.md", sha: null, at_ms: 0 });
    await vi.waitFor(
      async () => expect(await plugin.app.vault.adapter.exists("note.md")).toBe(false),
      UNTIL,
    );

    expect(await plugin.app.vault.adapter.exists("note.md")).toBe(false);
    expect(removedPaths).toEqual([]); // `remove` must never be the call that did this.
  });
});

describe("a manifest scan catches an edit the watcher never saw", () => {
  /**
   * `manifest-scan.ts` was written, tested, and never wired in
   * (`reconcile.ts`'s own doc comment named this exact gap: "a device that wants to catch
   * edits the watcher missed entirely ... is a later task's job"). The live vault listeners
   * only fire for an edit made WHILE this plugin instance is running — a file changed before
   * `onload` ever runs (another program, or an edit made while the plugin was disabled) is
   * invisible to them, and nothing else used to look.
   */
  it("pushes a file changed before this device ever loaded, with no create/modify event", async () => {
    stubWebSocket();
    const plugin = await load(
      { "a.md": "changed while this device was off\n" },
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        // A ledger from an earlier session, naming a.md at its OLD content — the mismatch
        // `reconcileManifest` must notice on its own, since no vault event ever will.
        appOptions: {
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              hashes: { "a.md": await contentHash("original\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);

    const puts = ws.upFrames().filter((f) => f.type === "put");
    expect(puts.map((f) => f.path)).toEqual(["a.md"]);
    void plugin;
  });

  it("pushes a delete for a ledger entry whose file is gone, with no delete event either", async () => {
    stubWebSocket();
    const plugin = await load(
      {}, // a.md is gone — deleted while this device was not running.
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        appOptions: {
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              hashes: { "a.md": await contentHash("used to be here\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "delete")).toBe(true),
      UNTIL,
    );
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const deletes = ws.upFrames().filter((f) => f.type === "delete");
    expect(deletes.map((f) => f.path)).toEqual(["a.md"]);
    void plugin;
  });

  /**
   * The same reconcile, over a file whose bytes are not UTF-8 — the case the whole
   * content gate exists for, driven through the real shell because that is where the two
   * halves meet: `scanManifest` cannot hash it, and `reconcileManifest` has to know that
   * "the scan produced no entry" is not "the file is gone".
   *
   * Three assertions, and each one is a different way this has gone wrong: it must not be
   * pushed (the vault refuses it with no `current_sha`, so `retry.ts` reports rather than
   * retries and every reconnect does it again — forever); it must not be DELETED (the
   * vault propagates that to every other device, destroying a file sitting right here);
   * and the user must be told, because a file silently absent between reconnects is the
   * failure this whole path is about.
   *
   * **Proven able to fail**, each independently:
   * - Reverting the delete pass to key off the scan's `onDisk` entries instead of the
   *   vault listing sends `{"type":"delete","path":"notes.txt"}` — this is the only case
   *   in the suite that catches it, measured.
   * - Deleting the `decodesAsText` guard in `deriveChanges` sends a `put` carrying the
   *   UTF-16 bytes and leaves the warning unspoken.
   * - Deleting the loop that makes an unhashed-but-listed path dirty leaves `changes`
   *   empty and the warning unspoken, with the first two assertions still green — which
   *   is what makes the third one worth asserting.
   */
  it("neither pushes nor deletes a file whose bytes are not UTF-8, and says so", async () => {
    stubWebSocket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // UTF-16LE with a BOM: what a `.txt` re-saved by another editor looks like on disk.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const plugin = await load(
      { "notes.txt": utf16 },
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        appOptions: {
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              // Synced when it was still UTF-8 — which is what makes the deletion
              // reachable at all: the path is in the ledger.
              hashes: { "notes.txt": await contentHash("hi\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    await settleMicrotasks(QUIET_MS + 500);

    expect(ws.upFrames().filter((f) => f.type === "put")).toEqual([]);
    expect(ws.upFrames().filter((f) => f.type === "delete")).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/not UTF-8 text.*notes\.txt/);
    void plugin;
  });

  /**
   * **One unreadable file must not cancel the rest of the reconcile.** `readBinary` answers
   * `null` for "gone before we looked", which every reader here already handles — but it
   * REJECTS for EACCES, for EIO, and for the check-then-use race where ENOENT lands between
   * `vaultFiles`'s `exists` and its read. `reconcileManifest` awaits `scanManifest` BEFORE
   * all three of its passes, so that rejection took the dirty marks, the warnings and the
   * ledger-deletion pass with it — and, because both call sites were `void ....then(...)`
   * with no `.catch()`, it did so as an unhandled rejection with nothing said. It fails the
   * same way on every reconnect for as long as the file stays unreadable, so a file deleted
   * while this device was offline is never propagated, ever.
   *
   * `gone.md` is the assertion that matters: it is in the ledger, it is not on disk, and
   * inferring its deletion is the pass this PR moved into the reconcile.
   *
   * **Proven able to fail**, and each mutation isolates a different half:
   * - Deleting `scanManifest`'s per-path `try`/`catch` leaves `deletes` empty — the whole
   *   reconcile is abandoned by the one file it could not read.
   * - Replacing `startReconcile`'s body with the old `void this.reconcileManifest().then(
   *   () => this.settler?.touch())` leaves this green, because the guard above now stops
   *   the throw before it ever reaches the call site. That is why the two are separate
   *   fixes with separate tests — the case below is the one that holds the `.catch()`.
   */
  it("still infers a deletion when another file cannot be read at all", async () => {
    stubWebSocket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = await load(
      { "locked.md": "on disk, and this device may not read it\n" },
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        appOptions: {
          // Listed, `exists`, `stat`s — and rejects when its bytes are asked for.
          unreadable: ["locked.md"],
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              hashes: { "gone.md": await contentHash("used to be here\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "delete")).toBe(true),
      UNTIL,
    );

    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const deletes = ws.upFrames().filter((f) => f.type === "delete");
    expect(deletes.map((f) => f.path)).toEqual(["gone.md"]);
    // And the file this device could not read is neither claimed nor destroyed: a path the
    // scan could not hash means "not claimed", never "not on disk".
    expect(ws.upFrames().filter((f) => f.type === "put")).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toContain("locked.md");
    void plugin;
  });

  /**
   * **The other half of the same fix: a rejection the scan's own guard cannot catch.**
   * Both call sites were `void this.reconcileManifest().then(...)` with no `.catch()`, so
   * anything the reconcile threw outside `scanManifest` — the vault listing, `vaultFiles`,
   * a bug in one of the three passes — became an unhandled rejection: nothing attributable
   * to this plugin in the console, no settle, and no way for anyone to tell it from a
   * device that simply had nothing to send.
   *
   * The listing is the reachable one, and it is stubbed only AFTER load: `reindexSpellings`
   * reads it at `onLayoutReady` too, so a vault that could never list would fail earlier and
   * measure something else. A second `ready` frame is a real reconnect, which is the moment
   * this path runs on every device.
   *
   * **Proven able to fail** by restoring `void this.reconcileManifest().then(() =>
   * this.settler?.touch())` at that call site: the warning is never printed, this goes red
   * on the `toContain`, and vitest additionally reports the rejection as unhandled — which
   * is exactly what nobody sees in a real Obsidian console.
   */
  it("reports a reconcile that fails outside the scan instead of dropping it", async () => {
    stubWebSocket();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = await load(
      { "a.md": "hi\n" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    vi.spyOn(plugin.app.vault, "getFiles").mockImplementation(() => {
      throw new Error("EIO: i/o error, scandir");
    });
    ws.emit({ type: "ready", seq: 1 });
    await vi.waitFor(
      () => expect(warn.mock.calls.flat().join(" ")).toContain("could not reconcile"),
      UNTIL,
    );
  });

  /**
   * **A withheld file has to reach the pane, not only the console.** `sync/status.ts`
   * documents `unsyncable` as "Files this device will not carry" and `describeStatus`
   * renders exactly the sentence one belongs in — but `setStatus` counted only the
   * Unicode-normalisation collisions in `shadowed`, so a user whose `notes.txt` was
   * re-saved as UTF-16 saw "Up to date" with nothing skipped and one line in a console
   * they will never open.
   *
   * The second half is the interesting one, and it is why `main.ts` keeps a `withheld`
   * SET rather than reading `undecodable.length` off the derive: a derive only ever visits
   * the paths in that settle's `touched`, so a count taken from its result alone reads 1 in
   * the window the file was edited and 0 in every window after it. The file is still on
   * disk, still unsynced, and the pane has gone quiet about it again.
   *
   * **Proven able to fail**, each independently:
   * - `unsyncable: this.shadowed.length` (the old line) fails the first assertion with 0.
   * - `unsyncable: this.shadowed.length + undecodable.length` — the one-line version —
   *   passes the first and fails the second with 0, which is the flicker this shape exists
   *   to prevent.
   */
  it("counts a withheld file in the status, and keeps counting it after a later settle", async () => {
    stubWebSocket();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const plugin = await load(
      { "notes.txt": utf16, "ok.md": "plain text\n" },
      {
        controlplaneOrigin: "https://cp.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
        appOptions: {
          localStorage: {
            "ctrlrouter:sync-state": {
              vaultId: "vault-1",
              cursor: 0,
              // `ok.md` already in step, deliberately: a settle that actually SENDS
              // something leaves `syncing` true until the vault acks, and this fake vault
              // never does — so the second settle below would be swallowed by the
              // re-arm guard and this case would measure nothing at all.
              hashes: { "ok.md": await contentHash("plain text\n") },
            },
          },
        },
      },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    await vi.waitFor(() => expect(plugin.syncStatus().unsyncable).toBe(1), UNTIL);
    expect(describeStatus(plugin.syncStatus())).toContain("not UTF-8 text");

    // A later settle that looked at a DIFFERENT file must not forget the withheld one.
    fireVaultEvent("modify", "ok.md");
    await settleMicrotasks(QUIET_MS + 500);

    expect(plugin.syncStatus().unsyncable).toBe(1);
  });
});

/**
 * The vault double itself, because a double that is gentler than the thing it stands in for
 * lets a caller pass here and fail in a vault.
 *
 * `adapter.read` answered `""` for a path not in the map — `bytesOf(undefined)` encodes the
 * empty string — which is "here is your file, and it is empty" for a file that does not
 * exist. That is the one answer that turns a lost file into an empty one written over every
 * other device, and no suite could catch it any more: `vaultFiles()` dropped `read` in the
 * same change that introduced it.
 *
 * **Proven able to fail** by restoring either accessor to `bytesOf(files[p])`: the read then
 * resolves with `""` (or an empty buffer) and both expectations go red. `read` is asserted
 * even though nothing in the sync path calls it — the next caller is the one this protects.
 */
describe("the vault double answers a missing path the way a real one does", () => {
  it("rejects rather than resolving with empty content", async () => {
    const adapter = fakeApp({ "here.md": "x" }).vault.adapter;
    await expect(adapter.read("nowhere.md")).rejects.toThrow(/ENOENT/);
    await expect(adapter.readBinary("nowhere.md")).rejects.toThrow(/ENOENT/);
    // The path that IS there still answers, and answers with its own bytes.
    expect(await adapter.read("here.md")).toBe("x");
  });
});

// ---------------------------------------------------------------------------------------
// D19 — the local adoption gate (design §5.3), through the real shell.
//
// `adopt.test.ts` holds the ordering itself against injected effects. This block holds the
// same property where the effects are REAL: a persisted vault id, an HTTP redemption, and
// an upload seeded into the live sync pipeline. A guard is only worth what it guards, and
// what it guards is here.
// ---------------------------------------------------------------------------------------

/** 32 bytes, base64url unpadded — `share::device::CHALLENGE_BYTES`, the only length the
 * server issues and the only one `fetchIntentChallenge` will sign over. */
const CHALLENGE_B64 = "A".repeat(43);

/** The three hops that happen before a human is asked: create the intent, take a challenge,
 * read the bound result. Queued in order — `requestUrl`'s fake answers by position. */
const queuePairingUpTo = (bound: {
  vaultId?: string;
  assertion?: string | null;
  pairingId?: string;
}): void => {
  requestUrlQueue.push({
    status: 201,
    json: { intent_id: "intent-1", expires_at: Date.now() + 600_000 },
  });
  requestUrlQueue.push({ status: 200, json: { challenge: CHALLENGE_B64 } });
  requestUrlQueue.push({
    status: 200,
    json: {
      state: "bound",
      pairing_id: bound.pairingId ?? "pai_1",
      vault_id: bound.vaultId ?? "vault-1",
      assertion: bound.assertion === undefined ? "pra2.abc" : bound.assertion,
    },
  });
};

/**
 * The two hops that happen AFTER the tap and before the redemption: the retrieval is run
 * again, so the assertion spent is one minted just now rather than one that aged out behind
 * an open modal (`ASSERTION_TTL_MS` is two minutes; a human is not on a timer).
 *
 * Queued separately from {@link queuePairingUpTo} on purpose — a test that never reaches a
 * tap must not have these sitting in the queue where a stray request could eat them.
 */
const queueRefreshAfterTap = (bound: { vaultId?: string; pairingId?: string } = {}): void => {
  requestUrlQueue.push({ status: 200, json: { challenge: CHALLENGE_B64 } });
  requestUrlQueue.push({
    status: 200,
    json: {
      state: "bound",
      pairing_id: bound.pairingId ?? "pai_1",
      vault_id: bound.vaultId ?? "vault-1",
      assertion: "pra2.fresh",
    },
  });
};

const redeemCalls = (): typeof requestUrlCalls =>
  requestUrlCalls.filter((c) => c.url.includes("/redeem"));

/**
 * The plugin's own dirty set, sorted.
 *
 * Reached through a cast because `touched` is private and has no reason not to be: what is
 * being asserted is that `seedInitialUpload` marked the pre-existing vault, at the moment it
 * ran and before anything else could have. Every other route to that fact — a `put` frame, a
 * pending count — is produced by the settle pipeline, which by then has also run
 * `reconcileManifest` and would report the same paths with the seed removed.
 */
const dirtyPaths = (plugin: CtrlNotesPlugin): string[] =>
  [...(plugin as unknown as { touched: { dirty: Set<string> } }).touched.dirty].sort();

/** A confirmation seam held open until a test answers it, exactly as a human staring at a
 * modal holds it open. */
const heldConfirmation = (): {
  confirm: ConfirmAdoption;
  answer: (yes: boolean) => void;
  opened: () => boolean;
} => {
  let settle: ((yes: boolean) => void) | null = null;
  return {
    confirm: () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    // An answer given before the plugin has asked is DROPPED (`settle` is still null), and
    // the pairing then waits on a modal nobody will answer until the test times out. That
    // is how "persists, redeems and uploads after the user confirms" failed under load: it
    // answered after a fixed 30 ms that the plugin had not yet reached the question in.
    // Wait for `opened()` before answering.
    answer: (yes) => {
      settle?.(yes);
      settle = null;
    },
    opened: () => settle !== null,
  };
};

describe("nothing is adopted until a human on this device says so", () => {
  /** **The guard.** An attacker who wins D16's race binds a pairing to this device's intent
   * first, and this plugin then legitimately READS a result naming the attacker's vault.
   * Everything below the tap is what that would cost. */
  it("does not persist, redeem or upload before the user confirms", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const gate = heldConfirmation();
    const plugin = await load(
      { "note.md": "private\n" },
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    plugin.confirmAdoption = gate.confirm;

    queuePairingUpTo({ vaultId: "attacker-vault" });
    void plugin.startPairing("My Laptop");
    await settleMicrotasks();

    expect(await plugin.loadData()).toMatchObject({ vaultId: "", deviceId: null });
    expect(redeemCalls()).toHaveLength(0);
    // `seedInitialUpload` has no observable effect but an upload, and an upload needs a
    // connection: a socket opened here is the vault's contents already leaving.
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  /** The positive, and it is not optional: without it the guard above passes on a plugin
   * that never pairs at all. */
  it("persists, redeems and uploads after the user confirms", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const gate = heldConfirmation();
    const plugin = await load(
      { "note.md": "already here before pairing\n" },
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    plugin.confirmAdoption = gate.confirm;

    queuePairingUpTo({});
    queueRefreshAfterTap();
    requestUrlQueue.push({ status: 201, json: { device_id: "dev-1" } });
    const pairing = plugin.startPairing("My Laptop");
    await vi.waitFor(() => expect(gate.opened()).toBe(true), UNTIL);
    gate.answer(true);
    await pairing;

    expect(await plugin.loadData()).toMatchObject({ vaultId: "vault-1", deviceId: "dev-1" });
    expect(redeemCalls()).toHaveLength(1);

    // **The upload half, asserted HERE and not after a `ready` frame**. This is
    // the instant `seedInitialUpload` has run and nothing else has dirtied anything:
    // Obsidian's own `create` replay fired long before this device was paired, and
    // `onLayoutReady`'s `reconcileManifest` is gated on `isPaired()`, which was false all
    // through load. An assertion taken after `ready` instead measures the reconcile that
    // runs on every `ready` — which would pass with `seedInitialUpload` deleted.
    expect(dirtyPaths(plugin)).toEqual(["note.md"]);

    // And that it really reaches the wire once a connection answers. The
    // socket appears a microtask after adoption — its URL carries a signed
    // routing proof (O6), so minting it is async.
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
    const puts = ws.upFrames().filter((f) => f.type === "put");
    expect(puts.map((f) => f.path)).toEqual(["note.md"]);
  });

  it("leaves nothing behind when the user declines", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const gate = heldConfirmation();
    const plugin = await load(
      { "note.md": "private\n" },
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    plugin.confirmAdoption = gate.confirm;

    queuePairingUpTo({});
    const pairing = plugin.startPairing("My Laptop");
    await vi.waitFor(() => expect(gate.opened()).toBe(true), UNTIL);
    gate.answer(false);
    await pairing;

    expect(await plugin.loadData()).toMatchObject({ vaultId: "", deviceId: null });
    expect(redeemCalls()).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    // Not half-paired: the intent is gone, so a reload does not resume a poll for something
    // this user has already refused.
    expect(plugin.app.loadLocalStorage("ctrlrouter:pairing-intent")).toBeNull();
  });

  /**
   * **PL4, after adoption.** "The plugin signs with its own vault id, never one taken from
   * a frame." The id adopted here came out of a response — what makes it the plugin's own
   * is the tap, and what this asserts is that the tap is what the signature follows. The
   * negative half matters as much: signing over the challenge alone, or over any other
   * vault id, is a signature transferable to a vault the user never chose.
   */
  it("signs with the adopted vault id", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    plugin.confirmAdoption = async () => true;

    queuePairingUpTo({ vaultId: "vault-adopted" });
    queueRefreshAfterTap({ vaultId: "vault-adopted" });
    requestUrlQueue.push({ status: 201, json: { device_id: "dev-1" } });
    await plugin.startPairing("My Laptop");
    // Adoption opens the socket, and its URL is minted asynchronously (a signed
    // routing proof, O6), so the transport appears a microtask later.
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    ws.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: "AAAA" });
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "hello")).toBe(true), UNTIL);

    const hello = ws.upFrames().find((f) => f.type === "hello");
    expect(hello).toBeDefined();
    // The same key the plugin itself loaded — `secretStorage` outlives one `DeviceIdentity`,
    // and ed25519 signatures are deterministic, so this reproduces the exact bytes.
    const identity = await DeviceIdentity.load(plugin.app);
    const challenge = decodeBase64Url("AAAA");
    expect(challenge).not.toBeNull();
    if (challenge === null) return;
    expect(hello?.signature).toBe(await identity.signChallenge("vault-adopted", challenge));
    expect(hello?.signature).not.toBe(await identity.signChallenge("vault-1", challenge));
    expect(hello?.signature).not.toBe(await identity.sign(challenge));
  });
});

describe("re-connecting to a different vault replaces the connection", () => {
  /**
   * **Found while wiring this up, not by the plan.** `SyncSocket` is constructed with the
   * vault id it signs every challenge for, and `startSyncing` returns early while a socket
   * exists — so adopting a second vault without dropping the first left the device
   * reporting itself connected to the new vault while it kept signing, and syncing, for the
   * old one. Nothing before this could reach that state: the only path back to
   * `startSyncing` used to be `unpair()`, which disconnects on the way through.
   */
  it("signs for the newly adopted vault, not the one it was already connected to", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      {
        controlplaneOrigin: "https://cp.test",
        webAppOrigin: "https://app.test",
        vaultId: "vault-old",
        deviceId: "dev-old",
      },
    );
    plugin.confirmAdoption = async () => true;
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await bringUp(first);

    queuePairingUpTo({ vaultId: "vault-new" });
    queueRefreshAfterTap({ vaultId: "vault-new" });
    requestUrlQueue.push({ status: 201, json: { device_id: "dev-new" } });
    await plugin.startPairing("My Laptop");

    expect(first.closed).toBe(true);
    // The replacement connection mints its own routing proof, so it appears a
    // microtask after the old one is dropped.
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    second.emit({ type: "challenge", wire_version: WIRE_VERSION, challenge: "AAAA" });
    await vi.waitFor(
      () => expect(second.upFrames().some((f) => f.type === "hello")).toBe(true),
      UNTIL,
    );
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    const hello = second.upFrames().find((f) => f.type === "hello");
    const identity = await DeviceIdentity.load(plugin.app);
    const challenge = decodeBase64Url("AAAA");
    expect(challenge).not.toBeNull();
    if (challenge === null) return;
    expect(hello?.device_id).toBe("dev-new");
    expect(hello?.signature).toBe(await identity.signChallenge("vault-new", challenge));
  });
});

describe("the arms a human is never asked about", () => {
  /** O2: a control plane with no signing key configured answers `assertion: null` —
   * production has had one since 2026-09-09, a self-hosted or development build may not.
   * Without this arm the user taps Connect and the redemption fails
   * with a refusal that names nothing they can act on. */
  it("says why, and asks nobody, when the control plane minted no assertion", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    let asked = 0;
    plugin.confirmAdoption = async () => {
      asked += 1;
      return true;
    };

    queuePairingUpTo({ assertion: null });
    await plugin.startPairing("My Laptop");

    expect(asked).toBe(0);
    expect(redeemCalls()).toHaveLength(0);
    expect(notices.map(noticeText).join(" ")).toMatch(/signing key/i);
  });

  it("reports an expired intent and forgets it, rather than polling a dead one forever", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );

    // An intent the control plane says is already over: `retrieveWhenBound` counts down to
    // the SERVER's instant, so this settles without a single poll.
    requestUrlQueue.push({
      status: 201,
      json: { intent_id: "intent-1", expires_at: Date.now() - 1 },
    });
    await plugin.startPairing("My Laptop");

    expect(plugin.app.loadLocalStorage("ctrlrouter:pairing-intent")).toBeNull();
    expect(notices.map(noticeText).join(" ")).toMatch(/expired/i);
  });
});

describe("the intent survives a cold launch, and the callback is only a hint", () => {
  /**
   * **The mobile case that broke draft three** (§5.1). Obsidian is backgrounded the moment
   * the system browser takes the foreground and may be killed there, so the process that
   * started the pairing is not the one that finishes it. Everything needed to finish is on
   * disk, outside the vault directory (PL1).
   */
  it("resumes a persisted intent on load, with no callback at all", async () => {
    stubWebSocket();
    stubSystemBrowser();
    requestUrlQueue.push({ status: 200, json: { challenge: CHALLENGE_B64 } });
    requestUrlQueue.push({
      status: 200,
      json: { state: "bound", pairing_id: "pai_1", vault_id: "vault-1", assertion: "pra2.abc" },
    });
    queueRefreshAfterTap();
    requestUrlQueue.push({ status: 201, json: { device_id: "dev-1" } });

    const plugin = await load(
      {},
      {
        controlplaneOrigin: "https://cp.test",
        webAppOrigin: "https://app.test",
        appOptions: {
          localStorage: {
            "ctrlrouter:pairing-intent": {
              intentId: "intent-1",
              expiresAt: Date.now() + 600_000,
            },
          },
        },
        // Before `onload`: the resume starts there, so a seam replaced afterwards is
        // replaced too late.
        prepare: (p) => {
          p.confirmAdoption = async () => true;
        },
      },
    );
    await vi.waitFor(
      async () =>
        expect(await plugin.loadData()).toMatchObject({ vaultId: "vault-1", deviceId: "dev-1" }),
      UNTIL,
    );
  });

  /** D15/rule 1: the callback carries nothing, so the most it may ever do is make the poll
   * run sooner. A plugin with no persisted intent must survive one from a stranger. */
  it("a callback for a device that is not pairing does nothing at all", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );

    for (const action of PAIRED_ACTIONS) {
      const handler = protocolHandlers.get(action);
      expect(handler, `no handler registered for ${action}`).toBeDefined();
      handler?.({ vault: "My Vault", code: "stolen", pair: "p1" });
    }
    await settleMicrotasks();

    expect(requestUrlCalls).toHaveLength(0);
    expect(await plugin.loadData()).toMatchObject({ vaultId: "", deviceId: null });
  });
});

describe("disconnecting this device", () => {
  /**
   * **Design §6.3, and the part that is not cosmetic.** No revoke path is reachable from
   * the plugin — hop 2 needs a browser-minted grant and the vault's own `DELETE
   * /v1/devices/{id}` needs the operator static token — so the vault row stays trusted
   * until somebody revokes it from the device list. What this device CAN do is stop being
   * able to use it, and that means the private key, not the settings: a device id is not a
   * credential and forgetting one leaves the key that proves possession of it sitting in
   * `secretStorage` for the next person with the laptop.
   */
  it("wipes the private key, so the old registration cannot be used again", async () => {
    stubWebSocket();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    const before = plugin.app.secretStorage.getSecret(SECRET_ID);
    expect(before).toBeTruthy();

    await plugin.disconnect();

    const after = plugin.app.secretStorage.getSecret(SECRET_ID);
    expect(after).not.toBe(before);
  });

  it("forgets the device id and the adopted vault", async () => {
    stubWebSocket();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );

    await plugin.disconnect();

    expect(await plugin.loadData()).toMatchObject({ vaultId: "", deviceId: null });
    // Both origins survive: they are this user's deployment, not this pairing's, and making
    // them re-type both to reconnect is a papercut with no security in it.
    expect(await plugin.loadData()).toMatchObject({ controlplaneOrigin: "https://cp.test" });
  });

  /**
   * A disconnected device must still be able to pair again — which needs an identity, and
   * the one it had has just been destroyed. Left null, `startPairing`'s `identity === null`
   * guard returns silently and the Pair button does nothing for the rest of the session.
   */
  it("leaves a working, DIFFERENT identity behind", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      {
        controlplaneOrigin: "https://cp.test",
        webAppOrigin: "https://app.test",
        vaultId: "vault-1",
        deviceId: "dev-1",
      },
    );

    // Two intent registrations either side of the disconnect, each refused immediately so
    // the poll never starts — the assertion is about the PUBLIC KEY in the request body,
    // which `registerPairingIntent` has already sent by the time the server says no.
    // Comparing the posted key against the stored SECRET instead would compare two
    // different things and pass however broken this is.
    const publicKeys = (): string[] =>
      requestUrlCalls
        .filter((c) => c.url.endsWith("/v1/pairing-intents"))
        .map((c) => (JSON.parse(c.body ?? "{}") as { public_key?: string }).public_key ?? "");

    requestUrlQueue.push({ status: 400, json: { detail: "no" } });
    await plugin.startPairing("My Laptop");
    const [before] = publicKeys();
    expect(before).toBeTruthy();

    await plugin.disconnect();

    requestUrlQueue.push({ status: 400, json: { detail: "no" } });
    await plugin.startPairing("My Laptop");
    const after = publicKeys()[1];

    // Pairing still runs at all (the identity was replaced, not merely destroyed) AND it
    // runs under a new key. Either half failing alone leaves the wipe pointless.
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("closes the socket rather than leaving one signing for the vault it just left", async () => {
    stubWebSocket();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();

    await plugin.disconnect();

    expect(ws?.closed).toBe(true);
  });
});

describe("an open settings pane and a pairing that moves", () => {
  /**
   * **Blocker regression.** The pane redraws on every pairing change, and a redraw drops its
   * subscription and takes a fresh one. A JS `Set` iterator visits values ADDED during its
   * own iteration, so notifying the live set walked straight into the listener it had just
   * been handed — forever, synchronously, on the UI thread. `main.ts`'s `snapshot()` is the
   * fix, and this is the only test that can see it: `settings-*.test.ts` drive the
   * subscription callback directly and never go through `notifyPairingChange` at all.
   *
   * Counted rather than timed. Left to run, the defect does not fail this test, it hangs
   * the whole suite — so the guard throws instead, which is a readable failure.
   */
  it("redraws a few times for one pairing, not unboundedly", async () => {
    stubWebSocket();
    stubSystemBrowser();
    const plugin = await load(
      {},
      { controlplaneOrigin: "https://cp.test", webAppOrigin: "https://app.test" },
    );
    const tab = new CtrlNotesSettingsTab(plugin.app, plugin);
    (tab.containerEl as unknown as { isConnected: boolean }).isConnected = true;

    let redraws = 0;
    const realDisplay = tab.display.bind(tab);
    vi.spyOn(tab, "display").mockImplementation(() => {
      redraws += 1;
      if (redraws > 20) throw new Error("the settings pane redrew unboundedly");
      realDisplay();
    });
    tab.display();

    // One refused registration: the run starts and ends, so at least one notify reaches an
    // open pane. A pairing that never notified would pass the ceiling below trivially,
    // which is why the floor is asserted too.
    requestUrlQueue.push({ status: 400, json: { detail: "no" } });
    await plugin.startPairing("My Laptop");

    expect(redraws).toBeGreaterThan(1);
    expect(redraws).toBeLessThan(6);
  });
});

describe("a first run points somewhere", () => {
  /**
   * **The one case `load()` cannot cover**, and therefore the one that would otherwise go
   * unmeasured: that helper writes a settings record before `onload`, so `DEFAULT_SETTINGS`
   * never applies in any other test in this file. A first run is exactly when it does.
   *
   * Design §7 asks for the shipped hostname by name rather than `""`. Pinned as literals
   * here on purpose — reading the constants back would assert only that a constant equals
   * itself, and what is worth protecting is the VALUE a stranger's fresh install dials.
   */
  it("ships the deployment's two hostnames rather than two blank fields", async () => {
    stubWebSocket();
    const plugin = new CtrlNotesPlugin(fakeApp({}), manifest);
    try {
      await plugin.onload();
      await plugin.ready;

      expect(plugin.controlplaneOrigin).toBe("https://sync.ctrlnotes.app");
      expect(plugin.webAppOrigin).toBe("https://ctrlnotes.app");
      // And it still does nothing at all until it is paired — a filled-in origin is not a
      // registration, and the honest default (this file's first case) has not moved.
      expect(plugin.vaultId).toBe("");
      expect(plugin.deviceId).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(0);
    } finally {
      plugin.unload();
    }
  });
});

describe("the web-app origin is its own setting", () => {
  /** Design §7: the web app and the control plane may be different hosts, so neither is a
   * derivation of the other. Until this had a setter, every Pair press refused with
   * `origin_not_configured` and the whole flow was unreachable. */
  it("persists what the settings pane sets", async () => {
    stubWebSocket();
    const plugin = await load({}, { controlplaneOrigin: "https://cp.test" });

    await plugin.setWebAppOrigin("https://app.test");

    expect(plugin.webAppOrigin).toBe("https://app.test");
    expect(await plugin.loadData()).toMatchObject({ webAppOrigin: "https://app.test" });
  });
});

describe("the status line reports what this device HOLDS, not what the vault has", () => {
  it("does not claim the vault's position on connect", async () => {
    // Measured before this was fixed: a device holding none of an 84-event
    // vault displayed `syncedCursor: 84`, because `ready` carries the VAULT's
    // current seq and the status was set straight from it. The settings pane
    // renders that number, so the plugin told the user it was current while it
    // had written nothing — which is how the missing content-fetch frame stayed
    // hidden behind a green UI, and it nearly inverted the experiment that
    // eventually found it.
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hi" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;

    // The vault is far ahead; this device has applied none of it.
    await bringUp(ws, 84);

    expect(plugin.syncStatus().syncedCursor).not.toBe(84);
  });
});

describe("a vault restarting for an update", () => {
  it("says so on the status line, without a notice, and clears it on reconnect", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hi" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws, 0);
    const noticesBefore = notices.length;

    vi.useFakeTimers();
    ws.closeWith(1012);
    expect(describeStatus(plugin.syncStatus())).toBe(UPDATING_TEXT);
    expect(notices.length).toBe(noticesBefore); // routine; the status line is enough

    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();
    // The reconnect's URL carries a real signature, so wait for the socket rather than for a
    // guess at how long signing takes: a fixed 30 ms failed this under a loaded machine.
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);
    const next = FakeWebSocket.instances[1];
    expect(next).toBeDefined();
    if (next === undefined) return;
    await bringUp(next, 0);
    expect(plugin.syncStatus().updating).toBe(false);
    expect(describeStatus(plugin.syncStatus())).not.toBe(UPDATING_TEXT);
  });
});

/**
 * **The shell's half of PL9, which the unit tests in `apply.test.ts` cannot
 * see.** Measured by the review of #168: dropping the ledger from the pump's
 * replay deps, making `onKept` a no-op, or never acting on `ResultOutcome.pull`
 * each left every other test green while switching the guard off on the live
 * path.
 */
describe("an unpushed edit, end to end through the shell", () => {
  const synced = async (path: string, text: string) => ({
    controlplaneOrigin: "https://cp.test",
    vaultId: "vault-1",
    deviceId: "dev-1",
    appOptions: {
      localStorage: {
        "ctrlrouter:sync-state": {
          vaultId: "vault-1",
          cursor: 0,
          hashes: { [path]: await contentHash(text) },
        },
      },
    },
  });

  it("uploads an edit an inbound change left alone, and never overwrites it", async () => {
    stubWebSocket();
    const plugin = await load({ "note.md": "synced\n" }, await synced("note.md", "synced\n"));
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    // Edited with no watcher event, so the ONLY thing that can get this edit
    // uploaded is the inbound path reporting it kept.
    await plugin.app.vault.adapter.writeBinary(
      "note.md",
      new TextEncoder().encode("local edit\n").buffer,
    );
    ws.sent.length = 0;

    ws.emit({
      type: "event",
      seq: 1,
      kind: "put",
      path: "note.md",
      sha: await contentHash("remote\n"),
      from: null,
      at_ms: 0,
    });
    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );
    await settleMicrotasks(QUIET_MS + 500); // quiet window: nothing ELSE follows

    expect(await plugin.app.vault.adapter.read("note.md")).toBe("local edit\n");
    const puts = ws.upFrames().filter((f) => f.type === "put" && f.path === "note.md");
    expect(puts).toHaveLength(1);
    // Against the base it was edited from — what makes the vault's merge exact.
    expect(puts[0]?.base_sha).toBe(await contentHash("synced\n"));
  });

  it("ends with the vault's version after the vault merged a push", async () => {
    stubWebSocket();
    const plugin = await load({ "note.md": "v0\n" }, await synced("note.md", "v0\n"));
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);
    ws.sent.length = 0;

    await plugin.app.vault.adapter.writeBinary(
      "note.md",
      new TextEncoder().encode("mine\n").buffer,
    );
    fireVaultEvent("modify", "note.md");
    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );

    // The vault merged it with someone else's edit: its reply names the merge.
    const merged = new TextEncoder().encode("theirs\nmine\n");
    const mergedSha = await contentHash("theirs\nmine\n");
    ws.emit({ type: "applied", path: "note.md", seq: 7, sha: mergedSha });
    await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "want")).toBe(true), UNTIL);

    const want = ws.upFrames().find((f) => f.type === "want");
    expect(want?.shas).toEqual([mergedSha]);
    ws.emit({ type: "blob", sha: mergedSha, bytes: merged.byteLength });
    ws.onmessage?.({ data: merged.buffer });
    await vi.waitFor(
      async () => expect(await plugin.app.vault.adapter.read("note.md")).toBe("theirs\nmine\n"),
      UNTIL,
    );
  });
});

describe("a refusal ends where its cause ends", () => {
  // Two real settle windows' worth of real timers, like the revocation test above.
  it("counts a refused FILE without reporting the session as refused", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hi" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (ws === undefined) return;
    await bringUp(ws);

    // A refusal answers a put in flight (`pump.ts`'s `settlePush`), so there must be one.
    fireVaultEvent("modify", "note.md");
    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );

    ws.emit({ type: "refused", path: "note.md", reason: "too large", current_sha: null });
    await vi.waitFor(() => expect(plugin.syncStatus().refused).toBeGreaterThan(0), UNTIL);
    await settleMicrotasks(); // …and a quiet window, so a double count would show as 2.

    // Before 2026-09-22 this set `refusal` too, which `describeStatus` renders ahead of
    // everything as "Sync was refused" — for one file, and with nothing to clear it.
    expect(plugin.syncStatus().refused).toBe(1);
    expect(plugin.syncStatus().refusal).toBeNull();
    expect(describeStatus(plugin.syncStatus())).toContain("refused by the server");
  });

  /**
   * A closing this device reconnects after is not a refusal at all (bulk-ingest design BI1):
   * it says `retrying`, never `refusal`, and the next `ready` clears it. Until BI1 it set
   * `refusal`, and until 2026-09-22 nothing cleared that either.
   */
  it("reports a retried closing as reconnecting, and clears it once reconnected", async () => {
    stubWebSocket();
    const plugin = await load(
      { "note.md": "hi" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws0 = FakeWebSocket.instances[0];
    expect(ws0).toBeDefined();
    if (ws0 === undefined) return;
    await bringUp(ws0);

    ws0.emit({
      type: "closing",
      reason: "too many connections open for this device",
      retry: "later",
    });
    await vi.waitFor(() => expect(plugin.syncStatus().retrying).not.toBeNull(), UNTIL);
    expect(plugin.syncStatus().refusal).toBeNull();

    // The first retry waits at most FIRST_RETRY_MS (1 s, jittered down from there).
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);
    const ws1 = FakeWebSocket.instances[1];
    expect(ws1).toBeDefined();
    if (ws1 === undefined) return;
    await bringUp(ws1);

    await vi.waitFor(() => expect(plugin.syncStatus().retrying).toBeNull(), UNTIL);
  });
});

/**
 * Bulk-ingest design BI1 and BI4, end to end through the shell: a closing the vault says to
 * retry after never ends an upload, and a device with work in flight reconnects by itself,
 * soon enough that the vault never sits quiet long enough to suspend.
 *
 * This is the 2026-09-25 failure. A busy vault answered `handshake timed out`, the plugin read
 * the text as terminal and disconnected, and with no socket open Fly suspended the vault in the
 * middle of a 20,000-file first sync that nothing then resumed.
 */
describe("a closing the vault says to retry after", () => {
  const PAIRED = { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" };

  /** A paired plugin whose ledger matches its files, up and quiet, then one edit put in flight
   * and never answered. */
  const putInFlight = async (): Promise<{ plugin: CtrlNotesPlugin; first: FakeWebSocket }> => {
    stubWebSocket();
    const files: Record<string, string> = { "note.md": "hi" };
    const hashes = { "note.md": await contentHash("hi") };
    const plugin = await load(files, {
      ...PAIRED,
      appOptions: {
        localStorage: { "ctrlrouter:sync-state": { vaultId: "vault-1", cursor: 0, hashes } },
      },
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    await settleMicrotasks(QUIET_MS + 500);

    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    await vi.waitFor(
      () => expect(first.upFrames().some((f) => f.type === "put")).toBe(true),
      UNTIL,
    );
    return { plugin, first };
  };

  const putsOn = (ws: FakeWebSocket) =>
    ws.upFrames().filter((f) => f.type === "put" && f.path === "note.md");

  /** A few microtask turns — `settleMicrotasks` sleeps on `setTimeout`, which these cases fake. */
  const microtasks = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  /**
   * **Proven able to fail** two ways: with `hasWork` left out of `SyncSocket`'s deps the
   * sixth reconnect waits 32 s and the wait for its socket runs out; with the `Notice` put
   * back on a retried closing the notice count moves.
   */
  it("a put in flight survives a later closing: the plugin reconnects by itself within 30 s, re-sends the put after ready, shows no Notice and never disconnects", async () => {
    const { plugin, first } = await putInFlight();
    const noticesBefore = notices.length;

    // The top of every jitter window, so an uncapped wait is the whole rung.
    vi.spyOn(Math, "random").mockReturnValue(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    first.emit({ type: "closing", reason: "busy", retry: "later" });
    await microtasks();

    const status = describeStatus(plugin.syncStatus());
    expect(status).toContain("still to send"); // the import's progress stays on screen
    expect(status).toContain('Reconnecting: the vault said "busy".');
    expect(plugin.syncStatus().refusal).toBeNull();

    // Six more failures after the closing push the uncapped rung to 64 s. Each reconnect must
    // still land inside `WORK_RETRY_MAX_MS`: the put is outstanding the whole time.
    for (let attempt = 1; attempt <= 7; attempt++) {
      vi.advanceTimersByTime(WORK_RETRY_MAX_MS);
      await untilRealClock(() => expect(FakeWebSocket.instances).toHaveLength(attempt + 1));
      if (attempt < 7) (FakeWebSocket.instances[attempt] as FakeWebSocket).close();
    }
    vi.useRealTimers();

    const last = FakeWebSocket.instances[7] as FakeWebSocket;
    await bringUp(last);
    await vi.waitFor(() => expect(putsOn(last)).toHaveLength(1), UNTIL);
    expect(notices.length).toBe(noticesBefore);
    expect(plugin.syncStatus().retrying).toBeNull();
    expect(plugin.syncStatus().refusal).toBeNull();
  });

  /** A vault older than BI1 sends no `retry`, and that is `later`. **Proven able to fail** by
   * decoding an absent field as `never`: no second socket, and a Notice. */
  it("a closing with no retry field is retried the same way", async () => {
    const { plugin, first } = await putInFlight();
    const noticesBefore = notices.length;

    first.emit({ type: "closing", reason: "handshake timed out" });
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    await bringUp(next);

    await vi.waitFor(() => expect(putsOn(next)).toHaveLength(1), UNTIL);
    expect(notices.length).toBe(noticesBefore);
    expect(plugin.syncStatus().refusal).toBeNull();
  });

  it("a never closing is terminal and shows a Notice", async () => {
    const { plugin, first } = await putInFlight();
    const noticesBefore = notices.length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    first.emit({ type: "closing", reason: "not authorised", retry: "never" });
    await microtasks();

    expect(notices.slice(noticesBefore).map(noticeText)).toEqual([
      "Disconnected from the Ctrl Notes vault: not authorised",
    ]);
    expect(plugin.syncStatus().refusal).toBe("not authorised");
    vi.advanceTimersByTime(10 * 60_000); // past every backoff step there is
    vi.useRealTimers();
    await settleMicrotasks(300); // quiet window: nothing reconnects
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("a top-level dot-folder is never synced, in either direction", () => {
  /**
   * Every config folder starts with a dot (Obsidian refuses any other), and devices sharing
   * a vault may each use a different one. The defect `hardcoded-config-path` found was
   * INBOUND: with only `.obsidian` refused, the vault could write another folder's
   * `plugins/x/data.json` onto this disk as an attachment. Outbound is asserted too,
   * although real Obsidian never lists a dot-path in `getFiles()` (this fake does).
   */
  it("acks an inbound put under a dot-folder without writing it, and never uploads one", async () => {
    stubWebSocket();
    const plugin = await load(
      { ".work-config/plugins/other/data.json": '{"token":"x"}', "note.md": "hi\n" },
      { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" },
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const ws = FakeWebSocket.instances[0];
    if (ws === undefined) return;
    await bringUp(ws);
    // Waited for on the note — a positive assertion — and only then is the dot-folder's
    // absence read: the same scan that sent the note has passed over it by then.
    const puts = (): unknown[] =>
      ws
        .upFrames()
        .filter((f) => f.type === "put")
        .map((f) => f.path);
    await vi.waitFor(() => expect(puts()).toContain("note.md"), UNTIL);
    expect(puts().some((p) => String(p).startsWith(".work-config/"))).toBe(false);

    ws.emit({
      type: "event",
      seq: 9,
      kind: "put",
      path: ".phone-config/plugins/x/data.json",
      sha: await contentHash('{"token":"theirs"}'),
      from: null,
      at_ms: 0,
    });
    await vi.waitFor(
      () => expect(ws.upFrames().some((f) => f.type === "ack" && f.seq === 9)).toBe(true),
      UNTIL,
    );
    expect(await plugin.app.vault.adapter.exists(".phone-config/plugins/x/data.json")).toBe(false);
  });
});

/**
 * Vault-sleep design VS4, VS5, VS8: the vault closes a socket that has been silent for 90 s,
 * so that its machine can suspend, and the plugin PARKS. A parked device holds no connection
 * and reconnects when there is something to sync — and only then, because every reconnect
 * resumes the vault it is trying to let sleep.
 */
describe("a parked device", () => {
  const PAIRED = { controlplaneOrigin: "https://cp.test", vaultId: "vault-1", deviceId: "dev-1" };

  /** Wait for the `n`th socket. A reconnect signs its URL first, so it lands when the event
   * loop has turned, not after any fixed wait (`UNTIL`). */
  const untilSockets = async (n: number): Promise<void> => {
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(n), UNTIL);
  };

  /** What the vault does after 90 s of silence: the reason, then 1000. */
  const idleClose = (ws: FakeWebSocket): void => {
    ws.emit({ type: "closing", reason: IDLE_REASON });
    ws.closeWith(1000);
  };

  /**
   * Load a paired plugin whose ledger already matches its files, bring its socket up and
   * park it. The matching ledger is what makes the park a quiet one: with nothing to send,
   * the load-time rescan pushes nothing, and anything that reconnects afterwards was a wake.
   */
  const parkedPlugin = async (
    files: Record<string, string> = { "note.md": "hi" },
  ): Promise<{ plugin: CtrlNotesPlugin; first: FakeWebSocket }> => {
    stubWebSocket();
    const hashes: Record<string, string> = {};
    for (const [path, body] of Object.entries(files)) hashes[path] = await contentHash(body);
    const plugin = await load(files, {
      ...PAIRED,
      appOptions: {
        localStorage: { "ctrlrouter:sync-state": { vaultId: "vault-1", cursor: 0, hashes } },
      },
    });
    plugin.random = () => 0; // no jitter: a signal wake fires on the next turn
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    // Let the load-time rescan and its settle finish before parking, so nothing they arm
    // can be mistaken for a wake.
    await settleMicrotasks(QUIET_MS + 500);
    idleClose(first);
    return { plugin, first };
  };

  it("says it is idle, without a notice, and does not reconnect on its own", async () => {
    const noticesBefore = notices.length;
    const { plugin, first } = await parkedPlugin();

    expect(first.closed).toBe(true);
    expect(describeStatus(plugin.syncStatus())).toBe("Up to date at change 0 (idle).");
    expect(notices.length).toBe(noticesBefore);
    expect(plugin.syncStatus().refusal).toBeNull();
    await settleMicrotasks(1_500); // past the first backoff step: nothing reconnects
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects at the edit, not after the settle, and pushes it", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    const { plugin } = await parkedPlugin(files);

    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    // Before the settle's quiet window has even elapsed (VS4: the wake overlaps it): the
    // wake is synchronous with the event, so `parked` is already clear.
    expect(plugin.syncStatus().parked).toBe(false);
    await untilSockets(2);
    const next = FakeWebSocket.instances[1];
    expect(next).toBeDefined();
    if (next === undefined) return;
    await bringUp(next);
    await vi.waitFor(() => expect(next.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
  });

  /**
   * **An idle close that races an outgoing push does not park the device with it unsent.**
   * The vault's idle arm sends its closing and returns, so a put sent in the last round trip
   * is dropped; `touched` was drained into it, the vault never committed it so no signal
   * comes, and a focused window is never refocused. The device reconnects at once, and
   * `ready` re-sends the head.
   *
   * **Proven able to fail** by removing the wake from `onIdle`: no second socket opens.
   * (`syncing` alone also covers this shape — `pushTouched` awaits the pump — and
   * `hasOutstanding` is the belt for a push that outlives its settle.)
   */
  it("reconnects at once when the idle close lands before a push was answered", async () => {
    stubWebSocket();
    const files: Record<string, string> = { "note.md": "hi" };
    const hashes = { "note.md": await contentHash("hi") };
    const plugin = await load(files, {
      ...PAIRED,
      appOptions: {
        localStorage: { "ctrlrouter:sync-state": { vaultId: "vault-1", cursor: 0, hashes } },
      },
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    await settleMicrotasks(QUIET_MS + 500);

    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    await vi.waitFor(
      () => expect(first.upFrames().some((f) => f.type === "put")).toBe(true),
      UNTIL,
    );
    idleClose(first); // before any `applied`

    await untilSockets(2);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    const rawSend = next.send.bind(next);
    next.send = (data: string | Uint8Array) => {
      rawSend(data);
      if (typeof data === "string") {
        const frame = JSON.parse(data) as { type?: string; path?: string; sha?: string };
        if (frame.type === "put")
          next.emit({ type: "applied", path: frame.path, seq: 1, sha: frame.sha });
      }
    };
    await bringUp(next);
    await vi.waitFor(
      () =>
        expect(next.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );
    await vi.waitFor(() => expect(plugin.syncStatus().pending).toBe(0), UNTIL);
  });

  /**
   * The same race one step earlier: the idle close lands while this device is still
   * DERIVING what it is about to send, so nothing is in the pump yet but `touched` has
   * already been drained. `syncing` is what says so.
   *
   * **Proven able to fail** by dropping `this.syncing` from `onIdle`'s check: no second
   * socket opens until something else wakes the device.
   */
  it("reconnects at once when the idle close lands mid-derive, and pushes the change", async () => {
    stubWebSocket();
    const files: Record<string, string> = { "note.md": "hi" };
    const hashes = { "note.md": await contentHash("hi") };
    await load(files, {
      ...PAIRED,
      appOptions: {
        localStorage: { "ctrlrouter:sync-state": { vaultId: "vault-1", cursor: 0, hashes } },
      },
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    await settleMicrotasks(QUIET_MS + 500);

    let release = (): void => {};
    readGates.set(
      "note.md",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    await settleMicrotasks(QUIET_MS + 200); // the settle fires; its derive waits on the read
    idleClose(first);

    await untilSockets(2);
    release();
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    await bringUp(next);
    await vi.waitFor(
      () =>
        expect(next.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );
  });

  /** A paired plugin whose ledger holds `note.md` at "hi", connected and past its load-time
   * rescan: the starting point of every race below. */
  const connectedPlugin = async (
    files: Record<string, string>,
  ): Promise<{ plugin: CtrlNotesPlugin; first: FakeWebSocket }> => {
    stubWebSocket();
    const hashes = { "note.md": await contentHash("hi") };
    const plugin = await load(files, {
      ...PAIRED,
      appOptions: {
        localStorage: { "ctrlrouter:sync-state": { vaultId: "vault-1", cursor: 0, hashes } },
      },
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    await settleMicrotasks(QUIET_MS + 500);
    return { plugin, first };
  };

  /** Answer every `put` this socket sends with `applied`, as a vault that took it would. */
  const acceptPuts = (ws: FakeWebSocket): void => {
    const rawSend = ws.send.bind(ws);
    ws.send = (data: string | Uint8Array) => {
      rawSend(data);
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { type?: string; path?: string; sha?: string };
      if (frame.type === "put")
        ws.emit({ type: "applied", path: frame.path, seq: 1, sha: frame.sha });
    };
  };

  /**
   * **The derive that outlives the idle close does not push into the reconnect's handshake.**
   * The mid-derive race above wakes the device; the derive then finishes while the new socket
   * is still handshaking. Sending then threw inside the pump and left the stale head queued
   * as in flight, so `ready` re-sent it beside the re-derived copy — one edit, two puts, and
   * the older one's outcome applied. `pushTouched` now checks the socket after the derive and
   * hands the changes back for `ready`'s settle.
   *
   * **Proven able to fail** twice: with both fixes removed, two puts; with only `main.ts`'s
   * readiness check removed, one put but through a thrown send ("could not send").
   */
  it("a derive that finishes during the reconnect's handshake pushes its change once", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    await connectedPlugin(files);
    const warn = vi.spyOn(console, "warn");

    let release = (): void => {};
    readGates.set(
      "note.md",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    await settleMicrotasks(QUIET_MS + 200); // the settle fires; its derive waits on the read
    idleClose(FakeWebSocket.instances[0] as FakeWebSocket);

    await untilSockets(2);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    acceptPuts(next);
    release();
    await settleMicrotasks(200); // the derive finishes while `next` has not even been challenged
    await bringUp(next);
    await vi.waitFor(
      () =>
        expect(next.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );
    await settleMicrotasks(QUIET_MS + 500); // quiet window: no second copy follows

    expect(next.upFrames().filter((f) => f.type === "put")).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("could not send"))).toBe(false);
  });

  /**
   * `onIdle`'s other half: a push the pump holds with no settle awaiting it, so `syncing` is
   * false and only `pump.hasOutstanding()` knows. Driven through the pump directly, because
   * every push `main.ts` makes itself is awaited inside a settle.
   *
   * **Proven able to fail** by deleting `|| pump.hasOutstanding()` from `onIdle`: the device
   * parks with the put unanswered and no second socket opens.
   */
  it("reconnects at once when the idle close lands with a push outstanding and no settle running", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    const { plugin, first } = await connectedPlugin(files);
    files["note.md"] = "edited";
    const content = new TextEncoder().encode("edited");
    const pump = (plugin as unknown as { pump: Pump }).pump;
    const pushed = pump.push({
      op: "put",
      path: "note.md",
      base: await contentHash("hi"),
      content,
      hash: await contentHash("edited"),
    });
    pushed.catch(() => {}); // rejected by `abandon` at unload if a case ends unanswered
    expect(first.upFrames().some((f) => f.type === "put")).toBe(true);
    expect((plugin as unknown as { syncing: boolean }).syncing).toBe(false);

    idleClose(first);

    await untilSockets(2);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    acceptPuts(next);
    await bringUp(next);
    await expect(pushed).resolves.toMatchObject({
      hashes: { "note.md": await contentHash("edited") },
    });
  });

  /**
   * **A vault that never answers does not keep itself awake through this device.** Each
   * idle close with the push still unanswered reconnects and re-sends; after
   * `MAX_IDLE_WAKES` in a row the device parks anyway, and says why in the console.
   *
   * **Proven able to fail** by making `decideIdleWake` ignore the cap: the device reconnects
   * after the last close too.
   */
  it("stops re-waking for an unanswered push after MAX_IDLE_WAKES idle closes", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    const { plugin, first } = await connectedPlugin(files);
    const warn = vi.spyOn(console, "warn");

    files["note.md"] = "edited";
    fireVaultEvent("modify", "note.md");
    await vi.waitFor(
      () => expect(first.upFrames().some((f) => f.type === "put")).toBe(true),
      UNTIL,
    );

    let ws = first;
    for (let wake = 1; wake <= MAX_IDLE_WAKES; wake++) {
      idleClose(ws); // never answered
      await untilSockets(wake + 1);
      ws = FakeWebSocket.instances[wake] as FakeWebSocket;
      await bringUp(ws);
      // `ready` re-sends the head: the vault is given every chance to answer it.
      await vi.waitFor(() => expect(ws.upFrames().some((f) => f.type === "put")).toBe(true), UNTIL);
    }
    idleClose(ws);
    await settleMicrotasks(500); // quiet window: no further reconnect

    expect(FakeWebSocket.instances).toHaveLength(MAX_IDLE_WAKES + 1);
    expect(plugin.syncStatus().parked).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("closed an idle connection"))).toBe(
      true,
    );
  });

  /**
   * PL9 while parked: a pull owed after a conflict writes no event and so brings no signal,
   * and attempted over a parked socket it fails as `no_socket` for good while the pane reads
   * "Up to date (idle)". The pull itself wakes the device. Started directly, on a device
   * already parked, so that nothing else — `onIdle`, a signal — could be what woke it.
   *
   * **Proven able to fail** by removing the wake from `attemptPull`: no second socket opens
   * and the file keeps this device's version.
   */
  it("wakes for a pull it owes, and lands the vault's version", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    const { plugin } = await parkedPlugin(files);
    const vaultText = "theirs\nhi\n";
    const vaultSha = await contentHash(vaultText);

    void (
      plugin as unknown as {
        pullVaultVersion(p: { path: string; pushed: string; vault: string }): Promise<void>;
      }
    ).pullVaultVersion({ path: "note.md", pushed: await contentHash("hi"), vault: vaultSha });

    await untilSockets(2);
    const next = FakeWebSocket.instances[1] as FakeWebSocket;
    await bringUp(next);
    await vi.waitFor(
      () => expect(next.upFrames().some((f) => f.type === "want")).toBe(true),
      UNTIL,
    );
    const bytes = new TextEncoder().encode(vaultText);
    next.emit({ type: "blob", sha: vaultSha, bytes: bytes.byteLength });
    next.onmessage?.({ data: bytes.buffer });
    await vi.waitFor(
      async () => expect(await plugin.app.vault.adapter.read("note.md")).toBe(vaultText),
      UNTIL,
    );
  });

  /**
   * The same, when the idle close lands while the pull's `want` is on the wire: the reset
   * fails it as transient, and the device reconnects at once rather than parking with it
   * stranded. Timers are faked across the close, so the pull's own 2 s backoff cannot be
   * what brings it back.
   *
   * **Proven able to fail** by deleting `|| fetcher.hasOutstanding()` from `onIdle`.
   */
  it("reconnects at once when the idle close lands with a want in flight", async () => {
    const files: Record<string, string> = { "note.md": "hi" };
    const { plugin, first } = await connectedPlugin(files);
    const vaultSha = await contentHash("theirs\nhi\n");
    void (
      plugin as unknown as {
        pullVaultVersion(p: { path: string; pushed: string; vault: string }): Promise<void>;
      }
    ).pullVaultVersion({ path: "note.md", pushed: await contentHash("hi"), vault: vaultSha });
    await vi.waitFor(
      () => expect(first.upFrames().some((f) => f.type === "want")).toBe(true),
      UNTIL,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    idleClose(first);
    await untilRealClock(() => expect(FakeWebSocket.instances).toHaveLength(2));
    vi.useRealTimers();
  });

  it("does not reconnect for an edit to a file it never sends", async () => {
    await parkedPlugin({ "note.md": "hi", "script.js": "x" });

    fireVaultEvent("modify", "script.js");
    await settleMicrotasks(QUIET_MS + 500);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects on Sync now, once however often it is pressed", async () => {
    await parkedPlugin();
    const syncNow = commands.find((c) => c.name === "Sync now");
    expect(syncNow).toBeDefined();

    syncNow?.callback?.();
    syncNow?.callback?.();
    await untilSockets(2);
    await settleMicrotasks(500); // quiet window: no third

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  const signalCalls = () => requestUrlCalls.filter((c) => c.url.includes("/v1/sync/signal"));

  /**
   * **Focus asks; it does not wake.** A wake resumes the vault, and a desktop is refocused
   * on every alt-tab, so waking on focus kept a busy machine's vault awake all day with
   * nothing to sync. Focus polls the control plane at once and wakes on the same answer the
   * minute tick would — without the jitter, because somebody is looking.
   *
   * **Proven able to fail** by restoring the focus listener to `wake()`: the first focus,
   * answered with the device's own position, opens a second socket.
   */
  it("polls when the window regains focus, and wakes only for a newer seq", async () => {
    await parkedPlugin();

    requestUrlQueue.push({ status: 200, json: { seq: 0 } }); // at its cursor
    fireDomEvent("focus");
    await vi.waitFor(() => expect(signalCalls()).toHaveLength(1), UNTIL);
    await settleMicrotasks(300); // quiet window
    expect(FakeWebSocket.instances).toHaveLength(1);

    fireDomEvent("focus"); // unscripted: a failed poll wakes nothing either
    await vi.waitFor(() => expect(signalCalls()).toHaveLength(2), UNTIL);
    await settleMicrotasks(300);
    expect(FakeWebSocket.instances).toHaveLength(1);

    requestUrlQueue.push({ status: 200, json: { seq: 5 } });
    fireDomEvent("focus");
    await untilSockets(2);
  });

  it("polls when Obsidian comes back to the foreground, not when it leaves it", async () => {
    await parkedPlugin();

    fakeDocument.visibilityState = "hidden";
    fireDomEvent("visibilitychange");
    await settleMicrotasks(300); // quiet window
    expect(signalCalls()).toEqual([]);

    requestUrlQueue.push({ status: 200, json: { seq: 0 } });
    fakeDocument.visibilityState = "visible";
    fireDomEvent("visibilitychange");
    await vi.waitFor(() => expect(signalCalls()).toHaveLength(1), UNTIL);
    await settleMicrotasks(300);
    expect(FakeWebSocket.instances).toHaveLength(1);

    requestUrlQueue.push({ status: 200, json: { seq: 3 } });
    fakeDocument.visibilityState = "hidden";
    fireDomEvent("visibilitychange");
    fakeDocument.visibilityState = "visible";
    fireDomEvent("visibilitychange");
    await untilSockets(2);
  });

  it("a trigger while connected opens nothing, and Sync now says it is already syncing", async () => {
    stubWebSocket();
    await load({ "note.md": "hi" }, PAIRED);
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    await bringUp(FakeWebSocket.instances[0] as FakeWebSocket);
    const noticesBefore = notices.length;

    fireDomEvent("focus");
    commands.find((c) => c.name === "Sync now")?.callback?.();
    await settleMicrotasks(500); // quiet window

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(signalCalls()).toEqual([]); // not parked: focus asks nothing
    expect(notices.slice(noticesBefore).map(noticeText)).toEqual([
      "Ctrl Notes is already syncing.",
    ]);
  });

  /**
   * "Sync now" during a drop's backoff reconnects now rather than doing nothing. The backoff
   * timer is faked and never advanced, so only the command can open the second socket.
   *
   * **Proven able to fail** by making `syncNow` return after the parked branch: no second
   * socket, and the wait runs out.
   */
  it("Sync now during a drop's backoff reconnects at once", async () => {
    stubWebSocket();
    await load({ "note.md": "hi" }, PAIRED);
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await bringUp(first);
    await settleMicrotasks(QUIET_MS + 500);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    first.close(); // an unplanned drop: a retry is scheduled on the (faked) backoff
    commands.find((c) => c.name === "Sync now")?.callback?.();
    await untilRealClock(() => expect(FakeWebSocket.instances).toHaveLength(2));
    vi.useRealTimers();
  });

  /**
   * VS5. A parked device was running throughout and its watchers saw every edit, so the
   * reconnect that ends a park skips the full rescan. The file changed here WITHOUT an event
   * is how the test sees whether a rescan ran: only a rescan could find it. The unplanned
   * drop afterwards is the control — the same change, found, because a drop does rescan.
   *
   * **Proven able to fail** by removing the `endsPark` guard in `main.ts`'s `ready`
   * handler: the first reconnect pushes `note.md`.
   */
  it("does not rescan the vault on the reconnect that ends a park, and does after a drop", async () => {
    const files: Record<string, string> = { "note.md": "one\n" };
    const { plugin } = await parkedPlugin(files);
    files["note.md"] = "two\n"; // no vault event: invisible to everything but a rescan

    commands.find((c) => c.name === "Sync now")?.callback?.();
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]).toBeDefined(), UNTIL);
    const woken = FakeWebSocket.instances[1] as FakeWebSocket;
    await bringUp(woken);
    await settleMicrotasks(QUIET_MS + 500);
    expect(woken.upFrames().filter((f) => f.type === "put")).toEqual([]);
    expect(plugin.syncStatus().parked).toBe(false);

    woken.close(); // an unplanned drop: the ordinary backoff, then a reconnect
    await vi.waitFor(() => expect(FakeWebSocket.instances[2]).toBeDefined(), UNTIL);
    const after = FakeWebSocket.instances[2] as FakeWebSocket;
    await bringUp(after);
    await vi.waitFor(
      () => expect(after.upFrames().some((f) => f.type === "put")).toBe(true),
      UNTIL,
    );
  });

  /**
   * VS5's exception. A backgrounded mobile app's JavaScript is suspended, so an edit made by
   * something else meanwhile may reach no watcher; a mobile device that went to the
   * background since its last `ready` rescans on the next one. The desktop case above is
   * the control: the same invisible edit, not found, because a desktop was running.
   *
   * **Proven able to fail** by dropping `backgroundedOnMobile` from the `endsPark` test in
   * `main.ts`'s `ready` handler: nothing is pushed.
   */
  it("rescans on the reconnect after a mobile device was in the background", async () => {
    Platform.isMobile = true;
    const files: Record<string, string> = { "note.md": "one\n" };
    await parkedPlugin(files);

    fakeDocument.visibilityState = "hidden";
    fireDomEvent("visibilitychange");
    files["note.md"] = "two\n"; // while suspended: no vault event
    fakeDocument.visibilityState = "visible";
    fireDomEvent("visibilitychange"); // an unscripted poll: fails, wakes nothing

    commands.find((c) => c.name === "Sync now")?.callback?.();
    await untilSockets(2);
    const woken = FakeWebSocket.instances[1] as FakeWebSocket;
    await bringUp(woken);
    await vi.waitFor(
      () =>
        expect(woken.upFrames().some((f) => f.type === "put" && f.path === "note.md")).toBe(true),
      UNTIL,
    );
  });

  describe("polls the control plane for its vault's seq", () => {
    /** Only `setInterval` is faked: the poll's own timer. A signature, a hash and the jitter
     * all need the real event loop (`settleMicrotasks`). */
    const fakePollTimer = (): void => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    };

    /** One poll, answered with `seq`. The short wait after it is a quiet window for the
     * negative assertions; a positive one waits with `untilSockets`. */
    const poll = async (seq: number | null): Promise<void> => {
      requestUrlQueue.push({ status: 200, json: { seq } });
      vi.advanceTimersByTime(SIGNAL_POLL_MS);
      await vi.waitFor(() => expect(requestUrlQueue).toHaveLength(0), UNTIL);
      await settleMicrotasks(100);
    };

    it("with its routing proof, and wakes for a seq past its cursor", async () => {
      fakePollTimer();
      await parkedPlugin();

      await poll(5);

      const [call] = signalCalls();
      expect(call?.method).toBe("GET");
      const url = new URL(call?.url ?? "");
      expect(`${url.origin}${url.pathname}`).toBe("https://cp.test/v1/sync/signal");
      expect([...url.searchParams.keys()].sort()).toEqual(["d", "k", "s", "t"]);
      expect(url.searchParams.get("d")).toBe("dev-1");
      await untilSockets(2);
    });

    it("does not wake for a seq at its cursor", async () => {
      fakePollTimer();
      await parkedPlugin();

      await poll(0);

      expect(signalCalls()).toHaveLength(1);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    /**
     * Plan §0 item 4. A cursor held below the vault's `seq` (PL8) would otherwise answer
     * "ahead" on every poll, and the device would resume its vault every minute for good.
     *
     * **Proven able to fail** by dropping the `wokeFor` comparison in `park.ts`'s
     * `decideSignalWake`: the second poll opens a third socket.
     */
    it("does not wake twice for the same seq, and does for a newer one", async () => {
      fakePollTimer();
      await parkedPlugin();

      await poll(5);
      await untilSockets(2);
      const second = FakeWebSocket.instances[1] as FakeWebSocket;
      await bringUp(second, 5); // the vault is at 5; this device applied nothing
      idleClose(second);

      await poll(5);
      expect(signalCalls()).toHaveLength(2);
      expect(FakeWebSocket.instances).toHaveLength(2);

      await poll(6);
      await untilSockets(3);
    });

    it("wakes once for a control plane that does not know, not on every poll", async () => {
      fakePollTimer();
      await parkedPlugin();

      await poll(null);
      await untilSockets(2);
      const second = FakeWebSocket.instances[1] as FakeWebSocket;
      await bringUp(second);
      idleClose(second);

      await poll(null);
      expect(signalCalls()).toHaveLength(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("wakes nothing on a refused or failed poll", async () => {
      fakePollTimer();
      await parkedPlugin();

      requestUrlQueue.push({ status: 401, json: { detail: "not authorised" } });
      vi.advanceTimersByTime(SIGNAL_POLL_MS);
      await vi.waitFor(() => expect(requestUrlQueue).toHaveLength(0), UNTIL);
      // An unscripted request rejects in the fake: a transport failure.
      vi.advanceTimersByTime(SIGNAL_POLL_MS);
      await vi.waitFor(() => expect(signalCalls()).toHaveLength(2), UNTIL);
      await settleMicrotasks(100);

      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    /**
     * **A poll that never settles does not latch polling off.** `requestUrl` has no abort,
     * and a half-open connection can leave it pending for a very long time; bounded, it
     * counts as a failure, and the next tick polls again.
     *
     * **Proven able to fail** by removing the timeout race from `pollSignal`: the first poll
     * never settles, `polling` stays set, and the test runs into its timeout.
     */
    it("gives up on a poll that never answers, and the next poll still wakes", async () => {
      const { plugin } = await parkedPlugin();
      // Driven directly: the interval is not what is under test, the latch is.
      const polls = plugin as unknown as { pollSignal(): Promise<void> };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      requestUrlHangs.next = 1;
      const first = polls.pollSignal();
      await vi.waitFor(() => expect(signalCalls()).toHaveLength(1), UNTIL);
      await vi.advanceTimersByTimeAsync(SIGNAL_TIMEOUT_MS);
      await first; // settled by the timeout, not by the request
      vi.useRealTimers();
      expect(FakeWebSocket.instances).toHaveLength(1);

      requestUrlQueue.push({ status: 200, json: { seq: 5 } });
      await polls.pollSignal();
      expect(signalCalls()).toHaveLength(2);
      await untilSockets(2);
    });

    it("does not poll while connected, or while hidden", async () => {
      fakePollTimer();
      stubWebSocket();
      await load({ "note.md": "hi" }, PAIRED);
      await vi.waitFor(() => expect(FakeWebSocket.instances[0]).toBeDefined(), UNTIL);
      const first = FakeWebSocket.instances[0] as FakeWebSocket;
      await bringUp(first);
      vi.advanceTimersByTime(SIGNAL_POLL_MS); // connected
      await settleMicrotasks(QUIET_MS + 500);

      idleClose(first);
      fakeDocument.visibilityState = "hidden";
      vi.advanceTimersByTime(SIGNAL_POLL_MS); // parked, but out of view
      await settleMicrotasks(100);

      expect(signalCalls()).toEqual([]);
    });

    /**
     * **Unload clears the tick.** Checked on the timer itself rather than by advancing it:
     * unload also unparks, and `pollSignal`'s own guard would then hide a tick left running.
     *
     * **Proven able to fail** by registering the interval with a bare `window.setInterval`
     * instead of `registerInterval`: one timer is left after unload.
     */
    it("leaves no poll timer behind after unload", async () => {
      fakePollTimer();
      const { plugin } = await parkedPlugin();
      expect(vi.getTimerCount()).toBe(1);

      plugin.unload();

      expect(vi.getTimerCount()).toBe(0);
    });

    /**
     * **An answer that lands after unload changes nothing.** `requestUrl` has no abort, so a
     * poll in flight at unload still answers. Unload also unparks, which would hide the
     * `active` guard; `parked` is put back so that the guard is the only thing in the way.
     *
     * **Proven able to fail** by removing `!this.active` from the check after the request
     * in `pollSignal`: the late answer is remembered and a wake is scheduled.
     */
    it("ignores a poll answer that lands after unload", async () => {
      const { plugin } = await parkedPlugin();
      const inside = plugin as unknown as {
        pollSignal(): Promise<void>;
        parked: boolean;
        wakeTimer: number | null;
        signalMemory: { wokeFor: number | null };
      };
      requestUrlHeld.next = 1;
      const polled = inside.pollSignal();
      await vi.waitFor(() => expect(requestUrlHeld.answers).toHaveLength(1), UNTIL);

      plugin.unload();
      inside.parked = true;
      requestUrlHeld.answers[0]?.({ status: 200, json: { seq: 5 } });
      await polled;
      await settleMicrotasks(100);

      expect(inside.signalMemory.wokeFor).toBeNull();
      expect(inside.wakeTimer).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });
});
