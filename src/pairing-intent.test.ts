// Task 19's tests (spec D2, D13, D15, PL1), against the real server contract read from
// `apps/controlplane/src/http/routes/pairing_intents.rs` — `POST /v1/pairing-intents` takes
// `{public_key, vault_name_suggestion}` and answers `201 {intent_id, expires_at}`.
//
// **The one shape that matters here is the fake's.** `fakeApp()` puts `saveData` on the
// SAME object `saveLocalStorage` lives on, the way a real Obsidian host offers both — a spy
// sitting beside the object under test cannot be reached by anything under test, which is a
// tripwire that cannot fail. `device.test.ts` and `sync/state.test.ts` both carry the same
// note for the same reason; this file is the third place the mistake would have been made.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPairingState,
  fetchIntentChallenge,
  INTENT_KEY,
  loadPairingState,
  type PairingDeps,
  type PairingHost,
  type PairingState,
  pairPageUrl,
  retrievePairingResult,
  retrieveWhenBound,
  savePairingState,
  startPairing,
} from "./pairing-intent.ts";
import { requestUrlCalls, requestUrlQueue } from "./testing/fake-obsidian.ts";

const CP = "https://cp.ctrlrouter.test";
const WEB = "https://app.ctrlrouter.test";
/** 32 bytes, base64url, unpadded — the shape `DeviceIdentity.publicKeyBase64` produces. */
const PUBKEY = "a".repeat(43);
const VAULT_NAME = "Work Notes";

afterEach(() => {
  requestUrlQueue.length = 0;
  requestUrlCalls.length = 0;
  vi.useRealTimers();
});

type FakeApp = PairingHost & {
  /** Obsidian's `Plugin.saveData` — writes `data.json` INSIDE the vault, which Obsidian
   * Sync replicates. Offered here so a regression that reached for it would have it in
   * hand; PL1 is that nothing does. */
  readonly saveData: ReturnType<typeof vi.fn>;
  readonly saveLocalStorage: ReturnType<typeof vi.fn>;
  /** The vault-scoped `localStorage` behind this app. Survives a cold launch. */
  readonly local: Map<string, unknown>;
  /** Anything `saveData` wrote, by path, so a test can look for a leak by content. */
  readonly vaultFiles: Map<string, string>;
};

const appOver = (local: Map<string, unknown>, name = VAULT_NAME): FakeApp => ({
  local,
  vaultFiles: new Map<string, string>(),
  vault: { getName: () => name },
  loadLocalStorage: (key: string) => local.get(key) ?? null,
  saveLocalStorage: vi.fn((key: string, data: unknown) => {
    if (data === null) local.delete(key);
    else local.set(key, data);
  }),
  saveData: vi.fn(function (this: FakeApp, d: unknown) {
    this.vaultFiles.set(".obsidian/plugins/ctrl-notes-cloud-mcp/data.json", JSON.stringify(d));
    return Promise.resolve();
  }),
});

const fakeApp = (name = VAULT_NAME): FakeApp => appOver(new Map(), name);

/**
 * The mobile case that broke draft three: the plugin's process does not survive the trip to
 * the browser. A cold launch is a NEW host over the SAME vault-scoped `localStorage` — every
 * in-memory field is gone, and only what reached disk comes back.
 */
const afterColdLaunch = (app: FakeApp): FakeApp => appOver(app.local);

const deps = (over: Partial<PairingDeps> = {}): PairingDeps => ({
  controlplaneOrigin: CP,
  webAppOrigin: WEB,
  publicKeyBase64: PUBKEY,
  openInSystemBrowser: vi.fn(),
  ...over,
});

const created = (intentId = "intent-1", expiresAt = 1_700_000_600_000) => ({
  status: 201,
  json: { intent_id: intentId, expires_at: expiresAt },
});

describe("starting a pairing registers an intent before the browser opens", () => {
  it("posts the device key and the vault name, and returns the intent", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    const r = await startPairing(app, deps());

    expect(r).toEqual({
      ok: true,
      value: {
        state: { intentId: "intent-1", expiresAt: 1_700_000_600_000 },
        url: `${WEB}/app/pair?i=intent-1`,
      },
    });
    expect(requestUrlCalls[0]?.url).toBe(`${CP}/v1/pairing-intents`);
    expect(requestUrlCalls[0]?.method).toBe("POST");
    // No `device_label` and no vault id: the human types the first at the confirm step
    // (D12) and the browser chooses the second from the vaults its session owns (D9).
    expect(JSON.parse(requestUrlCalls[0]?.body ?? "{}")).toEqual({
      public_key: PUBKEY,
      vault_name_suggestion: VAULT_NAME,
    });
  });

  it("opens the system browser at the pair page for this intent", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();
    const opened: string[] = [];

    await startPairing(app, deps({ openInSystemBrowser: (u) => void opened.push(u) }));

    expect(opened).toEqual([`${WEB}/app/pair?i=intent-1`]);
  });

  /** §5.4: one parameter, one name. A pair page reached without `?i=` has no intent to
   * bind and no way to recover one. */
  it("carries the intent id as ?i=, url-encoded", () => {
    expect(pairPageUrl("https://app.example/", "a/b c")).toBe(
      "https://app.example/app/pair?i=a%2Fb%20c",
    );
  });
});

describe("PL1: the intent id is persisted outside the vault directory", () => {
  /** PL1. The nonce is gone; what persists is `intent_id`, and it must not go into the
   * vault directory — `saveData` writes there and Obsidian Sync replicates it. A replicated
   * intent id is a second device racing to complete somebody else's pairing. */
  it("persists the intent id outside the vault directory", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    await startPairing(app, deps());

    expect(app.saveData).not.toHaveBeenCalled();
    expect(app.saveLocalStorage).toHaveBeenCalledWith(INTENT_KEY, {
      intentId: "intent-1",
      expiresAt: 1_700_000_600_000,
    });
    for (const contents of app.vaultFiles.values()) {
      expect(contents).not.toContain("intent-1");
    }
  });

  // Belt and braces, the same style `device.test.ts` and `pairing.test.ts` use for a claim
  // about a whole file rather than one call: even if a future host ever put `saveData`
  // somewhere this module COULD reach it, this grep still catches a call creeping back in.
  it("this module never calls a vault-replicated or secret persistence API", () => {
    const src = readFileSync(new URL("./pairing-intent.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.(saveData|setSecret)\s*\(/);
  });
});

describe("the intent survives the trip to the browser", () => {
  /** The mobile case that broke draft three: the plugin's process does not survive the trip
   * to the browser. Rebuild from disk and the flow must still complete. */
  it("finds its intent after a cold launch", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    await startPairing(app, deps());
    const revived = loadPairingState(afterColdLaunch(app));

    expect(revived?.intentId).toBe("intent-1");
    expect(revived?.expiresAt).toBe(1_700_000_600_000);
  });

  /** The ordering the cold launch above rests on. On mobile, Obsidian is backgrounded the
   * moment the browser takes the foreground and may be killed there — so anything persisted
   * *after* that call is persisted on a device that got lucky. Asserted from inside the
   * browser-opening callback, which is the only moment that can tell the two apart. */
  it("has already persisted the intent by the time the browser is asked", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();
    let onDiskWhenOpened: string | undefined;

    await startPairing(
      app,
      deps({
        openInSystemBrowser: () => {
          onDiskWhenOpened = loadPairingState(afterColdLaunch(app))?.intentId;
        },
      }),
    );

    expect(onDiskWhenOpened).toBe("intent-1");
  });

  /** D15: the plugin polls whether or not a callback ever arrives, so a lost deep link costs
   * time and nothing else. At this task's scope that property is an ABSENCE, and the await
   * below is the assertion: a `startPairing` that waited on an `obsidian://` callback would
   * never resolve, and this test would fail on the timeout. Everything the rest of the flow
   * needs is on disk when it returns. */
  it("completes with no callback at all", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    const r = await startPairing(app, deps());

    expect(r.ok).toBe(true);
    expect(loadPairingState(afterColdLaunch(app))?.intentId).toBe("intent-1");
    // One round trip, and nothing else was waited on.
    expect(requestUrlCalls).toHaveLength(1);
  });

  it("a second start replaces the first, so at most one intent is outstanding", async () => {
    requestUrlQueue.push(created("intent-1"));
    requestUrlQueue.push(created("intent-2", 1_700_000_900_000));
    const app = fakeApp();

    await startPairing(app, deps());
    await startPairing(app, deps());

    expect(loadPairingState(app)?.intentId).toBe("intent-2");
  });

  it("clearing removes the record entirely", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    await startPairing(app, deps());
    clearPairingState(app);

    expect(loadPairingState(app)).toBeNull();
    expect(app.local.has(INTENT_KEY)).toBe(false);
  });
});

describe("a refused creation leaves nothing behind", () => {
  it("persists nothing and opens no browser when the server refuses", async () => {
    requestUrlQueue.push({
      status: 429,
      json: {
        type: "https://ctrlnotes.app/errors/too-many-pairing-intents",
        title: "Too many pairing intents",
        status: 429,
        detail: "too many pairing requests are already outstanding",
      },
    });
    const app = fakeApp();
    const opened: string[] = [];

    const r = await startPairing(app, deps({ openInSystemBrowser: (u) => void opened.push(u) }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already outstanding/);
    expect(app.saveLocalStorage).not.toHaveBeenCalled();
    expect(loadPairingState(app)).toBeNull();
    expect(opened).toEqual([]);
  });

  /** The web app may be a different host from the control plane, so it is a separate
   * setting and can be blank on its own. Registering an intent first and only then finding
   * there is nowhere to send the browser leaves a live intent the user cannot complete. */
  it.each([
    ["the control plane origin", { controlplaneOrigin: "" }],
    ["the web app origin", { webAppOrigin: "" }],
  ])("refuses before creating anything when %s is unset", async (_name, over) => {
    const app = fakeApp();
    const opened: string[] = [];

    const r = await startPairing(
      app,
      deps({ ...over, openInSystemBrowser: (u) => void opened.push(u) }),
    );

    expect(r).toEqual({ ok: false, reason: "origin_not_configured" });
    expect(requestUrlCalls).toEqual([]);
    expect(loadPairingState(app)).toBeNull();
    expect(opened).toEqual([]);
  });

  it("surfaces a transport failure as a value, never a throw", async () => {
    const app = fakeApp();
    const r = await startPairing(app, deps());
    expect(r).toEqual({ ok: false, reason: "transport_failed" });
    expect(loadPairingState(app)).toBeNull();
  });

  it("reports an off-contract 201 rather than persisting half an intent", async () => {
    requestUrlQueue.push({ status: 201, json: { intent_id: "intent-1" } });
    const app = fakeApp();

    const r = await startPairing(app, deps());

    expect(r).toEqual({ ok: false, reason: "unexpected_response" });
    expect(loadPairingState(app)).toBeNull();
  });

  /** The intent is live at this point — it was created and persisted before the browser was
   * asked for — so the record deliberately stays. `pairPageUrl` rebuilds the link from it. */
  it("keeps the intent when the browser refuses to open, and says so", async () => {
    requestUrlQueue.push(created());
    const app = fakeApp();

    const r = await startPairing(
      app,
      deps({
        openInSystemBrowser: () => {
          throw new Error("no handler for https");
        },
      }),
    );

    expect(r).toEqual({ ok: false, reason: "browser_failed" });
    expect(loadPairingState(app)?.intentId).toBe("intent-1");
  });
});

describe("loadPairingState refuses anything that is not exactly what we wrote", () => {
  const revive = (raw: unknown) => {
    const app = fakeApp();
    app.local.set(INTENT_KEY, raw);
    return loadPairingState(app);
  };

  it("reads nothing as never started", () => {
    expect(loadPairingState(fakeApp())).toBeNull();
  });

  it.each([
    ["not an object", "intent-1"],
    ["no intent id", { expiresAt: 1 }],
    ["an empty intent id", { intentId: "", expiresAt: 1 }],
    ["no expiry", { intentId: "intent-1" }],
    ["a non-integer expiry", { intentId: "intent-1", expiresAt: 1.5 }],
    ["an unsafe expiry", { intentId: "intent-1", expiresAt: 2 ** 53 + 2 }],
  ])("reads %s as never started", (_name, raw) => {
    expect(revive(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Task 20: D14 — retrieve the result by signing.
//
// Two hops per attempt: `GET …/challenge` issues 32 single-use bytes, `POST …/result`
// spends them together with a signature over
// `share::device::intent_context_message(intent_id, challenge)`. Read against the real
// server contract in `apps/controlplane/src/http/routes/pairing_intents.rs` and
// `commands/retrieve_pairing_result.rs`.
// ---------------------------------------------------------------------------------------

/** 32 bytes — `share::device::CHALLENGE_BYTES`, the only length the server issues. */
const challengeBytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const CHALLENGE_A = challengeBytes(0xa1);
const CHALLENGE_B = challengeBytes(0xb2);
const CHALLENGE_C = challengeBytes(0xc3);

const issued = (bytes: Uint8Array) => ({ status: 200, json: { challenge: b64url(bytes) } });

const unbound = () => ({
  status: 200,
  json: { state: "unbound", pairing_id: null, vault_id: null, assertion: null },
});

const bound = (assertion: string | null = "pra2.body.sig") => ({
  status: 200,
  json: { state: "bound", pairing_id: "pai_1", vault_id: "vault-1", assertion },
});

const notFound = () => ({
  status: 404,
  json: {
    type: "https://ctrlnotes.app/errors/no-such-pairing-intent",
    title: "No such pairing intent",
    status: 404,
    detail: "no such pairing intent",
  },
});

/**
 * Stands in for `DeviceIdentity.signIntent`, deterministic in BOTH inputs — so a test can
 * read a posted `signature` and say exactly which intent id and which challenge bytes it
 * was built from. A stub that ignored its arguments would let the loop sign one challenge
 * and post another and still pass.
 */
const stubSigner = () => {
  const signed: Array<{ intentId: string; challenge: Uint8Array }> = [];
  return {
    signed,
    signIntent(intentId: string, challenge: Uint8Array): Promise<string> {
      signed.push({ intentId, challenge });
      return Promise.resolve(`sig(${intentId}:${[...challenge].join(".")})`);
    },
  };
};

const signatureFor = (intentId: string, challenge: Uint8Array): string =>
  `sig(${intentId}:${[...challenge].join(".")})`;

/** Ten minutes before `STATE.expiresAt`, so an injected clock leaves the whole budget. */
const NOW = 1_700_000_000_000;
const STATE: PairingState = { intentId: "intent-1", expiresAt: NOW + 600_000 };

describe("GET …/challenge", () => {
  it("asks this intent for a challenge and decodes the bytes", async () => {
    requestUrlQueue.push(issued(CHALLENGE_A));

    const r = await fetchIntentChallenge(CP, "in/tent 1");

    expect(requestUrlCalls[0]?.url).toBe(`${CP}/v1/pairing-intents/in%2Ftent%201/challenge`);
    expect(requestUrlCalls[0]?.method).toBe("GET");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.value.bytes]).toEqual([...CHALLENGE_A]);
      // Kept verbatim rather than re-encoded: the server looks the row up by the bytes this
      // string decodes to, and a second encoder on this side is a way for the lookup and
      // the signature to disagree about which challenge is being spent.
      expect(r.value.base64url).toBe(b64url(CHALLENGE_A));
    }
  });

  /**
   * The plugin puts its signature over bytes the server chose. Domain separation is what
   * makes that safe (`intentContextMessage`), and the fixed length is the other half: the
   * concatenation is only unambiguous while the challenge is exactly `CHALLENGE_BYTES`.
   * Refusing here also means a wrong-length challenge is never signed at all, rather than
   * signed and then refused as an opaque 400.
   */
  it.each([
    ["shorter than the server ever issues", b64url(new Uint8Array(31).fill(7))],
    ["longer than the server ever issues", b64url(new Uint8Array(33).fill(7))],
    ["not base64url at all", "not base64!"],
    ["the standard alphabet, not base64url", "a+b/c="],
  ])("refuses a challenge that is %s", async (_name, challenge) => {
    requestUrlQueue.push({ status: 200, json: { challenge } });

    const r = await fetchIntentChallenge(CP, "intent-1");

    expect(r).toEqual({ ok: false, reason: "unexpected_response", retryable: true });
  });

  it("reports a 404 as the server's final answer, not a hiccup", async () => {
    requestUrlQueue.push(notFound());

    const r = await fetchIntentChallenge(CP, "intent-1");

    expect(r).toEqual({
      ok: false,
      reason: "no such pairing intent",
      retryable: false,
    });
  });

  it("surfaces a transport failure as a retryable value, never a throw", async () => {
    const r = await fetchIntentChallenge(CP, "intent-1");
    expect(r).toEqual({ ok: false, reason: "transport_failed", retryable: true });
  });
});

describe("POST …/result", () => {
  /** **D20: there is no code, and there must never be one again.** The body is exactly the
   * proof, and nothing else — a field added here is a field the server would have to accept
   * from an unauthenticated caller. */
  it("posts the challenge and the signature, and nothing else", async () => {
    requestUrlQueue.push(bound());

    await retrievePairingResult(CP, "in/tent 1", b64url(CHALLENGE_A), "sig-abc");

    expect(requestUrlCalls[0]?.url).toBe(`${CP}/v1/pairing-intents/in%2Ftent%201/result`);
    expect(requestUrlCalls[0]?.method).toBe("POST");
    expect(JSON.parse(requestUrlCalls[0]?.body ?? "{}")).toEqual({
      challenge: b64url(CHALLENGE_A),
      signature: "sig-abc",
    });
  });

  it("reads unbound as a result that has not arrived yet", async () => {
    requestUrlQueue.push(unbound());
    const r = await retrievePairingResult(CP, "intent-1", "c", "s");
    expect(r).toEqual({ ok: true, value: { state: "unbound" } });
  });

  it("reads bound as the pairing, the vault and the assertion", async () => {
    requestUrlQueue.push(bound());
    const r = await retrievePairingResult(CP, "intent-1", "c", "s");
    expect(r).toEqual({
      ok: true,
      value: {
        state: "bound",
        pairing: { pairingId: "pai_1", vaultId: "vault-1", assertion: "pra2.body.sig" },
      },
    });
  });

  /** `mint_assertion` answers `None` when the control plane has no signing key configured
   * (O2 — a self-hosted or development build; production has one since 2026-09-09). Bound
   * is still the honest answer: the human confirmed in the browser, and it is the
   * redemption that cannot proceed. Reporting it beats polling out a ten-minute budget for
   * a value that will never appear. */
  it("reads bound with no assertion as bound, not as still waiting", async () => {
    requestUrlQueue.push(bound(null));
    const r = await retrievePairingResult(CP, "intent-1", "c", "s");
    expect(r.ok && r.value.state).toBe("bound");
    expect(r.ok && r.value.state === "bound" && r.value.pairing.assertion).toBeNull();
  });

  it("reads redeemed as a pairing that is already spent", async () => {
    requestUrlQueue.push({
      status: 200,
      json: { state: "redeemed", pairing_id: "pai_1", vault_id: "vault-1", assertion: null },
    });
    const r = await retrievePairingResult(CP, "intent-1", "c", "s");
    expect(r).toEqual({
      ok: true,
      value: { state: "redeemed", pairingId: "pai_1", vaultId: "vault-1" },
    });
  });

  it.each([
    ["a state this plugin does not model", { state: "approved", pairing_id: "p", vault_id: "v" }],
    ["bound with no vault id", { state: "bound", pairing_id: "p", vault_id: null }],
    ["bound with no pairing id", { state: "bound", pairing_id: "", vault_id: "v" }],
    ["no state at all", { pairing_id: "p", vault_id: "v" }],
  ])("reports %s rather than guessing", async (_name, json) => {
    requestUrlQueue.push({ status: 200, json });
    const r = await retrievePairingResult(CP, "intent-1", "c", "s");
    expect(r).toEqual({ ok: false, reason: "unexpected_response", retryable: true });
  });
});

describe("retrieveWhenBound polls until the human has confirmed in the browser", () => {
  /** The named property: the browser step takes as long as a human takes, so `unbound` is
   * the normal answer and not an error. Each attempt must spend a FRESH challenge — they
   * are single-use, so a loop that reused one would answer 404 on its second pass and
   * report the pairing dead while the user was still typing. */
  it("keeps polling while the result is unbound", async () => {
    requestUrlQueue.push(issued(CHALLENGE_A), unbound());
    requestUrlQueue.push(issued(CHALLENGE_B), unbound());
    requestUrlQueue.push(issued(CHALLENGE_C), bound());
    const signer = stubSigner();

    const settled = await retrieveWhenBound(CP, STATE, signer, new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(settled).toEqual({
      status: "bound",
      pairing: { pairingId: "pai_1", vaultId: "vault-1", assertion: "pra2.body.sig" },
    });
    // Three attempts, two hops each, and a new challenge every time.
    expect(requestUrlCalls).toHaveLength(6);
    expect(signer.signed.map((s) => [...s.challenge])).toEqual([
      [...CHALLENGE_A],
      [...CHALLENGE_B],
      [...CHALLENGE_C],
    ]);
  });

  /** The binding that makes the proof a proof: the signature posted is over the challenge
   * that was just issued, for THIS intent. A loop that signed one and posted another would
   * be refused by the server with a 404 nobody could diagnose (AT8). */
  it("posts a signature over the challenge it was just handed, for its own intent id", async () => {
    requestUrlQueue.push(issued(CHALLENGE_A), unbound());
    requestUrlQueue.push(issued(CHALLENGE_B), bound());
    const signer = stubSigner();

    await retrieveWhenBound(CP, STATE, signer, new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    for (const [challenge, call] of [
      [CHALLENGE_A, requestUrlCalls[1]],
      [CHALLENGE_B, requestUrlCalls[3]],
    ] as const) {
      expect(JSON.parse(call?.body ?? "{}")).toEqual({
        challenge: b64url(challenge),
        signature: signatureFor(STATE.intentId, challenge),
      });
    }
  });

  it("stops on a redeemed pairing rather than polling out the budget", async () => {
    requestUrlQueue.push(issued(CHALLENGE_A), {
      status: 200,
      json: { state: "redeemed", pairing_id: "pai_1", vault_id: "vault-1", assertion: null },
    });

    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(settled).toEqual({ status: "redeemed" });
    expect(requestUrlCalls).toHaveLength(2);
  });

  /** A 4xx is the server's considered answer about this intent, so asking again cannot
   * change it — and each attempt costs one of the 300 challenges the intent will ever be
   * issued. */
  it("stops when the server refuses the intent, rather than retrying a settled answer", async () => {
    requestUrlQueue.push(notFound());

    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(settled).toEqual({ status: "refused", reason: "no such pairing intent" });
    expect(requestUrlCalls).toHaveLength(1);
  });

  /** A closed laptop lid, a proxy having a bad minute, an off-contract body: none of those
   * is the server refusing this pairing, and reporting one as a refusal tells the user they
   * lost something the network never delivered. The transport case itself is pinned on
   * `fetchIntentChallenge` above; this is the loop's half of it. */
  it("spends an attempt on a server hiccup instead of ending the flow", async () => {
    requestUrlQueue.push({ status: 503, json: null });
    requestUrlQueue.push(issued(CHALLENGE_A), { status: 200, json: { state: "nonsense" } });
    requestUrlQueue.push(issued(CHALLENGE_B), bound());

    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(settled).toEqual({
      status: "bound",
      pairing: { pairingId: "pai_1", vaultId: "vault-1", assertion: "pra2.body.sig" },
    });
  });

  it("gives up after the attempt budget rather than polling forever", async () => {
    for (let i = 0; i < 3; i++) requestUrlQueue.push(issued(CHALLENGE_A), unbound());

    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      maxAttempts: 3,
      now: () => NOW,
    });

    expect(settled).toEqual({ status: "expired" });
    expect(requestUrlCalls).toHaveLength(6);
  });

  /**
   * The reason `expiresAt` is persisted at all (Task 19). After a cold launch the plugin
   * gets the REMAINING window, not a fresh ten minutes — and an intent whose window has
   * already closed costs no request at all, rather than 300 doomed round trips.
   */
  it("makes no request for an intent whose window has already closed", async () => {
    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      now: () => STATE.expiresAt,
    });

    expect(settled).toEqual({ status: "expired" });
    expect(requestUrlCalls).toEqual([]);
  });

  it("reports a cancelled flow as cancelled, not as expired", async () => {
    const controller = new AbortController();
    controller.abort();

    const settled = await retrieveWhenBound(CP, STATE, stubSigner(), controller.signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(settled).toEqual({ status: "cancelled" });
    expect(requestUrlCalls).toEqual([]);
  });

  /** Each attempt appends a challenge row, and the server will only ever issue 300 for one
   * intent (`MAX_CHALLENGES_PER_INTENT`, derived from a two-second poll over ten minutes).
   * Polling faster does not make the human answer sooner; it burns that budget early and
   * turns the last minutes of a live pairing into 429s. */
  it("waits between attempts instead of hammering a capped resource", async () => {
    vi.useFakeTimers();
    requestUrlQueue.push(issued(CHALLENGE_A), unbound());
    requestUrlQueue.push(issued(CHALLENGE_B), bound());

    const settling = retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      now: () => NOW,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestUrlCalls).toHaveLength(2); // attempt 0 waits for nothing

    await vi.advanceTimersByTimeAsync(500);
    expect(requestUrlCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(requestUrlCalls).toHaveLength(4);

    await expect(settling).resolves.toEqual({
      status: "bound",
      pairing: { pairingId: "pai_1", vaultId: "vault-1", assertion: "pra2.body.sig" },
    });
  });

  /**
   * D19 lives in Task 22, and this loop must leave room for it: retrieving a result is not
   * adopting one. The state the loop READS is untouched when it returns — no clear, no
   * rewrite — so the intent is still there for the confirm step, or for a second attempt
   * after a cold launch.
   *
   * **The stronger half of this is structural, not a test.** `retrieveWhenBound` is handed a
   * `PairingState` value and never a `PairingStore`, so there is no store here to write
   * through; asserting "it did not persist" against a fake it cannot reach is the tripwire
   * that cannot fail this file's own header warns about. What is asserted below is what a
   * test can actually observe.
   */
  it("leaves the persisted intent exactly as it found it", async () => {
    requestUrlQueue.push(issued(CHALLENGE_A), bound());
    const app = fakeApp();
    savePairingState(app, STATE);
    (app.saveLocalStorage as ReturnType<typeof vi.fn>).mockClear();

    await retrieveWhenBound(CP, STATE, stubSigner(), new AbortController().signal, {
      intervalMs: 0,
      now: () => NOW,
    });

    expect(app.saveLocalStorage).not.toHaveBeenCalled();
    expect(loadPairingState(app)).toEqual(STATE);
  });
});
