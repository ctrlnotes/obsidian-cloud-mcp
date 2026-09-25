// The pairing INTENT: the first hop of device pairing, and the value that survives the trip
// to the browser (design §5, §5.1; decisions D2, D13, D15, PL1).
//
//   plugin  --POST /v1/pairing-intents {public_key, vault_name_suggestion}--> control plane
//           <-- 201 {intent_id, expires_at} ------------------------------------------------
//           persist intent_id  (saveLocalStorage — PL1)
//           open the SYSTEM browser at <webAppOrigin>/app/pair?i=<intent_id>
//
// **The plugin still starts the flow (D2)**, because it is the entry point a user has and a
// browser cannot know which local Obsidian vault is meant. It sends its public key and the
// Obsidian vault's name as a *suggestion*, and nothing else: there is deliberately no
// `device_label` and no vault id on this row. The human types the device label at the
// confirm step and the browser picks the vault from the ones its own session owns (D9, D12),
// so an unauthenticated row carries neither.
//
// **Creating an intent confers nothing.** It is unauthenticated because the plugin has no
// account and cannot get one. An intent grants access only once a signed-in session binds a
// pairing to it (D16), and its result is released only to whoever can sign with the private
// half of the key the intent names (D14, Task 20).
//
// **PL1 — the intent id goes to `saveLocalStorage`, never `saveData`.** `saveData` writes
// `.obsidian/plugins/<id>/data.json` INSIDE the vault, which Obsidian Sync replicates to
// every other device; a replicated intent id is a second device racing to complete somebody
// else's pairing. `saveLocalStorage` is per-device and Obsidian already scopes it per vault.
// It is also not `secretStorage`, which PL1 reserves for the device key — an intent id is an
// identifier, not a secret, and design §10 row 1 prices exactly what a party who reads one
// can do.
//
// **There is no local nonce.** Drafts one to three kept one, and it was what broke on a
// mobile cold launch: the plugin's process does not survive the trip to the browser, so a
// value held only in memory is gone by the time the answer is ready. The intent does the
// same job better, because the server holds the other half of it.
//
// **The deep link is not part of this hop.** `obsidian://` carries no secret (D15) and the
// plugin retrieves its result by proving possession of the device key regardless of whether
// a callback ever arrives — so a lost or hijacked callback costs time and nothing else. That
// retrieval is Task 20; `startPairing` never waits for anything a callback would deliver.

import type { App, Vault } from "obsidian";
import { reasonFrom, request } from "./controlplane-http.ts";
import type { DeviceIdentity } from "./device.ts";
import { CHALLENGE_BYTES, decodeBase64Url } from "./device.ts";

/**
 * The vault-scoped `localStorage` slice this module writes.
 *
 * Narrow on purpose, and the type comes from the real `obsidian` package: a test fakes two
 * methods rather than constructing an `App`, and a signature drift is a typecheck failure
 * rather than a fake that quietly disagrees. `sync/state.ts`'s `LocalStore` is the same
 * shape for the same reason. **`saveData` is deliberately absent** — see PL1 above.
 */
export type PairingStore = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

/** What `startPairing` needs from the Obsidian host: the store, plus the vault's own name. */
export type PairingHost = PairingStore & { readonly vault: Pick<Vault, "getName"> };

/** One key, so at most one intent is outstanding on this device at a time. */
export const INTENT_KEY = "ctrlrouter:pairing-intent";

/**
 * A pairing this device has started and not yet finished.
 *
 * **`expiresAt` is carried, not recomputed.** The server hands it back in the 201, and after
 * a cold launch it is the only thing that tells the plugin how much of the intent's ten
 * minutes is left. Without it a revived plugin polls a dead intent for a fresh ten.
 */
export interface PairingState {
  readonly intentId: string;
  /** Milliseconds since the epoch, from the control plane's own clock. */
  readonly expiresAt: number;
}

/**
 * Anything that is not exactly what we wrote reads as a device that has not started pairing,
 * the same posture `loadSyncState` takes next door. There is nothing to repair here: a
 * half-read record names an intent this device may not be able to sign for, and the correct
 * recovery is the one the user already knows — press Pair again.
 */
export const loadPairingState = (store: PairingStore): PairingState | null => {
  const raw: unknown = store.loadLocalStorage(INTENT_KEY);
  if (typeof raw !== "object" || raw === null) return null;
  const { intentId, expiresAt } = raw as { intentId?: unknown; expiresAt?: unknown };
  if (typeof intentId !== "string" || intentId === "") return null;
  // `isSafeInteger`, not `isInteger`: `Number.MAX_VALUE` and `2 ** 53 + 2` are both integers
  // by the looser test, and either one read back as an expiry is an intent that never times
  // out. `sync/state.ts` draws the line in the same place.
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return null;
  }
  return { intentId, expiresAt };
};

export const savePairingState = (store: PairingStore, state: PairingState): void => {
  store.saveLocalStorage(INTENT_KEY, { intentId: state.intentId, expiresAt: state.expiresAt });
};

/** Obsidian clears the entry on `null`, which is what "this device is not pairing" is. */
export const clearPairingState = (store: PairingStore): void => {
  store.saveLocalStorage(INTENT_KEY, null);
};

export type IntentResult =
  | { readonly ok: true; readonly value: PairingState }
  | { readonly ok: false; readonly reason: string };

/**
 * `POST /v1/pairing-intents` — unauthenticated (D13): the device is asking, not acting.
 *
 * `publicKeyBase64` is **base64url with no padding** (design §8), which is exactly what
 * `DeviceIdentity.publicKeyBase64` produces. It is *not* `publicKeyStandardBase64` — that
 * conversion exists for the redemption hop, whose `public_key` field decodes with the
 * STANDARD alphabet on both legs. This repo runs both alphabets on adjacent surfaces, so the
 * encoding is pinned rather than inferred; the server pins the same one
 * (`create_pairing_intent.rs`'s `standard_base64_is_not_base64url`).
 */
export const createPairingIntent = async (
  controlplaneOrigin: string,
  publicKeyBase64: string,
  vaultNameSuggestion: string,
): Promise<IntentResult> => {
  const r = await request(controlplaneOrigin, "/v1/pairing-intents", "POST", {
    public_key: publicKeyBase64,
    vault_name_suggestion: vaultNameSuggestion,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const { status, body } = r.value;
  if (status < 200 || status >= 300) return { ok: false, reason: reasonFrom(status, body) };
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "unexpected_response" };
  }
  const { intent_id, expires_at } = body as { intent_id?: unknown; expires_at?: unknown };
  if (typeof intent_id !== "string" || intent_id === "") {
    return { ok: false, reason: "unexpected_response" };
  }
  if (typeof expires_at !== "number" || !Number.isSafeInteger(expires_at) || expires_at <= 0) {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: true, value: { intentId: intent_id, expiresAt: expires_at } };
};

/**
 * The pair page for one intent. **One parameter, one name: `?i=`** (design §5.4).
 *
 * `/app` is the authenticated area, and the gate in front of it owns sign-in and the return
 * trip — including preserving this query string across it (O10). A page that arrives without
 * `?i=` has no intent to bind and no way to recover one.
 *
 * Exported so a caller can rebuild the link from a persisted `intentId` when the browser
 * failed to open, without re-registering an intent.
 */
export const pairPageUrl = (webAppOrigin: string, intentId: string): string =>
  `${webAppOrigin.replace(/\/+$/, "")}/app/pair?i=${encodeURIComponent(intentId)}`;

export interface PairingDeps {
  /** Where `POST /v1/pairing-intents` goes. */
  readonly controlplaneOrigin: string;
  /** Where the system browser is sent — the web app, which may be a different host. */
  readonly webAppOrigin: string;
  /** This device's ed25519 public key, base64url with no padding. */
  readonly publicKeyBase64: string;
  /**
   * Opens a URL in the **system** browser (design §5.6) — see {@link openInSystemBrowser} for
   * why it must not be a WebView, and what is and is not verified about the default.
   *
   * Injected rather than called directly so a test can observe the URL: nothing that opens a
   * real browser is callable from a test process.
   */
  readonly openInSystemBrowser: (url: string) => void | Promise<void>;
}

/**
 * The default {@link PairingDeps.openInSystemBrowser}.
 *
 * **The system browser, not a WebView** (design §5.6). Google refuses OAuth from an embedded
 * WebView (`disallowed_useragent`), and a WebView's cookie jar is not the system browser's,
 * so a user already signed in would be asked again and the return trip would break.
 *
 * `window.open(url, "_blank")` is what reaches it on both platforms Obsidian ships: the
 * desktop app is Electron and hands an external `https` URL to the OS, and the mobile app is
 * Capacitor, whose WebView does the same. Obsidian exports no browser-opening API of its own
 * (checked against `obsidian.d.ts` 1.13.1), so there is nothing more specific to call.
 *
 * **A named gap, the same one `testing/fake-obsidian.ts` declares.** No test can prove where
 * a URL actually lands — the suite runs on Node, and both behaviours above live inside a
 * real Obsidian. This is checked by manual acceptance on each platform and by nothing else,
 * and design §10's second accepted risk depends on it holding.
 */
export const openInSystemBrowser = (url: string): void => {
  window.open(url, "_blank");
};

export interface StartedPairing {
  readonly state: PairingState;
  /** The URL the browser was sent to. */
  readonly url: string;
}

export type StartPairingResult =
  | { readonly ok: true; readonly value: StartedPairing }
  | { readonly ok: false; readonly reason: string };

/**
 * Register a pairing intent, remember it, and send the user to the browser to confirm it.
 *
 * **The order is the point.** The intent is persisted BEFORE the browser is opened, because
 * on mobile this process does not survive the trip: Obsidian is backgrounded and may be
 * killed the moment the browser takes the foreground. Anything still only in memory at that
 * moment is gone, and the user comes back to a plugin that has no idea what it started.
 *
 * **Nothing is persisted when the server refuses.** A record naming an intent that does not
 * exist would have the plugin poll for a result that can never arrive.
 *
 * **This returns as soon as the browser has been asked.** It never waits on an `obsidian://`
 * callback — the callback carries no secret and may never arrive at all (D15), so the flow
 * continues from the persisted intent id alone (Task 20).
 */
export async function startPairing(
  app: PairingHost,
  deps: PairingDeps,
): Promise<StartPairingResult> {
  // **Both origins are checked here, before anything is created.** They are separate
  // settings and the web app may be a different host, so an unconfigured `webAppOrigin`
  // would otherwise register a real intent, persist it, and then send the browser to a
  // RELATIVE `/app/pair?i=…` — which resolves against `app://obsidian.md` and reaches
  // nothing. Refusing up front costs the user a settings prompt instead of a live intent
  // they cannot complete and an error that names the wrong thing.
  if (deps.controlplaneOrigin === "" || deps.webAppOrigin === "") {
    return { ok: false, reason: "origin_not_configured" };
  }

  const created = await createPairingIntent(
    deps.controlplaneOrigin,
    deps.publicKeyBase64,
    app.vault.getName(),
  );
  if (!created.ok) return created;

  // Replaces any earlier intent: at most one is outstanding on this device, and the one the
  // user just started is the one they are about to confirm.
  savePairingState(app, created.value);

  const url = pairPageUrl(deps.webAppOrigin, created.value.intentId);
  try {
    await deps.openInSystemBrowser(url);
  } catch {
    // The intent is live and persisted, so the record deliberately stays — `pairPageUrl`
    // rebuilds the same link from it, and a user who reaches the page another way still
    // completes the pairing this call started.
    return { ok: false, reason: "browser_failed" };
  }
  return { ok: true, value: { state: created.value, url } };
}

// ---------------------------------------------------------------------------------------
// D14 — retrieving the result, by proving possession of the device key.
//
//   plugin  --GET  /v1/pairing-intents/{id}/challenge ------------------> control plane
//           <-- {challenge}  32 bytes, single-use, two-minute life ---------------------
//           --POST /v1/pairing-intents/{id}/result {challenge, signature} ------------->
//           <-- {state, pairing_id, vault_id, assertion}  (no code — D20) --------------
//
// **The credential is a signature, because there is nothing else it could be.** The plugin
// has no account and no bearer token; what it has is the private half of the key the intent
// itself names, so the result is released to whoever can sign with it and to nobody else.
// Neither hop sits behind an auth layer — the third authenticates in the handler
// (`apps/controlplane/src/http/routes/pairing_intents.rs`).
//
// **What this proves is who may READ the answer, not who CHOSE it** (design §5.3 — the
// sentence that killed two drafts). An attacker who wins D16's race binds a pairing to this
// intent first, and this device then legitimately reads a result naming the attacker's
// vault. Nothing in this file may therefore adopt anything: D19's local confirmation is
// Task 22, and it is the only thing standing between that race and the user's notes.
//
// **A poll, not a callback.** `obsidian://` carries no secret and may never arrive at all
// (D15), so the loop below runs regardless and a lost deep link costs time only.
// ---------------------------------------------------------------------------------------

/**
 * How often the result is polled. **Two seconds, and not faster** — this is
 * `pairing_intent::MIN_POLL_INTERVAL_MS`, the number the server's
 * `MAX_CHALLENGES_PER_INTENT` cap is derived from.
 *
 * Each attempt appends a challenge row, and one intent will ever be issued 300 of them.
 * Polling faster does not make a human answer sooner; it spends that budget early and turns
 * the last minutes of a live pairing into 429s.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * The most attempts one intent gets — `pairing_intent::MAX_CHALLENGES_PER_INTENT`, which is
 * a ten-minute intent polled every two seconds.
 *
 * **A backstop, not the real budget.** The real one is `PairingState.expiresAt`, which is
 * the server's own clock and survives a cold launch; this bounds the loop if a device's
 * clock is wrong enough that the deadline never arrives.
 */
const MAX_ATTEMPTS = 300;

/**
 * Just enough of {@link DeviceIdentity} to prove possession — a `Pick`, so this module needs
 * no keypair and a test hands it a stub. Drift in `signIntent`'s signature is a typecheck
 * failure here rather than a stub that quietly disagrees with the real thing.
 */
export type IntentSigner = Pick<DeviceIdentity, "signIntent">;

/**
 * One refusal from either hop.
 *
 * **`retryable` is the whole judgement in this file.** A 4xx is the server's considered
 * answer about this intent and cannot change by being asked again — 404 for
 * unknown/expired/unverifiable (AT8 folds all three into one on purpose), 429 for the
 * challenge cap, 400 for a proof this plugin built wrong. Everything else — a transport
 * failure, a 5xx, a body that is not on contract — is a hiccup, and the loop spends an
 * attempt on it rather than telling the user they were refused something the network never
 * delivered.
 */
export interface HopRefused {
  readonly ok: false;
  readonly reason: string;
  readonly retryable: boolean;
}

const isFinalAnswer = (status: number): boolean => status >= 400 && status < 500;

/** A response that is not what the contract says. Retryable: one garbled body — a proxy's
 * error page, a truncated read — is not this intent being refused. */
const offContract = (): HopRefused => ({
  ok: false,
  reason: "unexpected_response",
  retryable: true,
});

export interface IntentChallenge {
  /**
   * Exactly the string the server sent, echoed back verbatim on the result hop rather than
   * re-encoded from {@link bytes}. The server finds the challenge row by the bytes this
   * decodes to, so a second encoder on this side is a way for the row being spent and the
   * message being signed to disagree about which challenge this is.
   */
  readonly base64url: string;
  /** The decoded bytes, exactly `CHALLENGE_BYTES` of them. What gets signed. */
  readonly bytes: Uint8Array;
}

export type ChallengeResult = { readonly ok: true; readonly value: IntentChallenge } | HopRefused;

/**
 * `GET /v1/pairing-intents/{intent_id}/challenge` — unauthenticated, and it hands back
 * nothing usable: a challenge is a nonce, and it opens the result only together with a
 * signature by the private half of the key the intent named.
 *
 * **The length is checked here, before anything is signed.** These are bytes the server
 * chose, and this device is about to put its signature over them. Domain separation
 * (`intentContextMessage`) is what makes that safe at all; the challenge being exactly
 * `CHALLENGE_BYTES` is the other half, because the concatenation is unambiguous only while
 * one of its two variable parts is not. The server would refuse the round trip anyway
 * (`RetrievePairingResultError::Malformed`) — but only after the signature existed.
 */
export const fetchIntentChallenge = async (
  controlplaneOrigin: string,
  intentId: string,
): Promise<ChallengeResult> => {
  const path = `/v1/pairing-intents/${encodeURIComponent(intentId)}/challenge`;
  const r = await request(controlplaneOrigin, path, "GET");
  if (!r.ok) return { ok: false, reason: r.reason, retryable: true };
  const { status, body } = r.value;
  if (status < 200 || status >= 300) {
    return { ok: false, reason: reasonFrom(status, body), retryable: !isFinalAnswer(status) };
  }
  if (typeof body !== "object" || body === null) return offContract();
  const { challenge } = body as { challenge?: unknown };
  if (typeof challenge !== "string") return offContract();
  const bytes = decodeBase64Url(challenge);
  if (bytes === null || bytes.length !== CHALLENGE_BYTES) return offContract();
  return { ok: true, value: { base64url: challenge, bytes } };
};

/** A pairing a signed-in browser bound to this intent. */
export interface BoundPairing {
  readonly pairingId: string;
  /**
   * **The one place this plugin ever learns a vault id** (D11). It may be adopted only
   * through D19's local gate — reading it here is not choosing it.
   */
  readonly vaultId: string;
  /**
   * The `pairing_assertion` the vault checks at redemption, or `null` when the control
   * plane has no signing key configured (O2 — production's was minted 2026-09-09, so this
   * is a self-hosted or development control plane built without one; `mint_assertion`
   * answers `None` rather than inventing something the vault would accept).
   *
   * **There is no `code` here and there must never be one again** (D20).
   */
  readonly assertion: string | null;
}

/** The three states `retrieve_pairing_result::ResultState` serialises, modelled so that
 * "unbound carries no ids" is structural rather than a comment. */
export type PairingOutcome =
  | { readonly state: "unbound" }
  | { readonly state: "bound"; readonly pairing: BoundPairing }
  | { readonly state: "redeemed"; readonly pairingId: string; readonly vaultId: string };

export type RetrieveResult = { readonly ok: true; readonly value: PairingOutcome } | HopRefused;

/**
 * `POST /v1/pairing-intents/{intent_id}/result` — spend the challenge and read the answer.
 *
 * **The body is the proof and nothing else** (D20): a `challenge` and a `signature`, both
 * base64url with no padding. A field added here is a field an unauthenticated route would
 * have to accept.
 *
 * A POST that reads, deliberately — it spends a single-use challenge, so it is not
 * idempotent and could not be a GET.
 */
export const retrievePairingResult = async (
  controlplaneOrigin: string,
  intentId: string,
  challengeBase64Url: string,
  signatureBase64Url: string,
): Promise<RetrieveResult> => {
  const path = `/v1/pairing-intents/${encodeURIComponent(intentId)}/result`;
  const r = await request(controlplaneOrigin, path, "POST", {
    challenge: challengeBase64Url,
    signature: signatureBase64Url,
  });
  if (!r.ok) return { ok: false, reason: r.reason, retryable: true };
  const { status, body } = r.value;
  if (status < 200 || status >= 300) {
    return { ok: false, reason: reasonFrom(status, body), retryable: !isFinalAnswer(status) };
  }
  if (typeof body !== "object" || body === null) return offContract();

  const { state, pairing_id, vault_id, assertion } = body as {
    state?: unknown;
    pairing_id?: unknown;
    vault_id?: unknown;
    assertion?: unknown;
  };
  if (state === "unbound") return { ok: true, value: { state: "unbound" } };
  if (state !== "bound" && state !== "redeemed") return offContract();

  // Bound and redeemed both name a pairing and a vault. A body that says one of those
  // states without them is not a result this plugin can act on, and guessing at the missing
  // half is how a device ends up adopting nothing in particular.
  if (typeof pairing_id !== "string" || pairing_id === "") return offContract();
  if (typeof vault_id !== "string" || vault_id === "") return offContract();
  if (state === "redeemed") {
    return { ok: true, value: { state: "redeemed", pairingId: pairing_id, vaultId: vault_id } };
  }
  if (assertion !== null && assertion !== undefined && typeof assertion !== "string") {
    return offContract();
  }
  return {
    ok: true,
    value: {
      state: "bound",
      pairing: {
        pairingId: pairing_id,
        vaultId: vault_id,
        assertion: typeof assertion === "string" && assertion !== "" ? assertion : null,
      },
    },
  };
};

/** Sleep, or wake early if `signal` fires. An abort listener on an ALREADY-aborted signal
 * never fires, so a caller must check `signal.aborted` itself before relying on this to
 * return promptly — which the loop below does, on both sides of the wait. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/**
 * How one attempt goes: take a fresh challenge, sign it, spend it.
 *
 * **Exported because the retrieval is run twice, not once** (`adopt.ts`). The assertion a
 * result carries lives two minutes (`apps/controlplane/src/pairing.rs`'s `ASSERTION_TTL_MS`)
 * and D19 puts a human between reading one and spending it, so the redemption re-runs this
 * and redeems with the assertion it just minted rather than one that aged out behind a
 * modal. A second attempt is cheap and legal: `retrieve_pairing_result` mints a fresh
 * assertion on every bound read and marks nothing as spent.
 *
 * **Still not a way to adopt anything.** Like {@link retrieveWhenBound}, this takes no
 * `PairingStore` and writes nothing; reading a result is not acting on one.
 */
export const retrieveOnce = async (
  controlplaneOrigin: string,
  intentId: string,
  device: IntentSigner,
): Promise<RetrieveResult> => {
  const challenge = await fetchIntentChallenge(controlplaneOrigin, intentId);
  if (!challenge.ok) return challenge;
  // `intentId` is this device's own persisted id, never one read out of a response — the
  // same rule that governs which vault id a sync challenge is signed for.
  const signature = await device.signIntent(intentId, challenge.value.bytes);
  return retrievePairingResult(controlplaneOrigin, intentId, challenge.value.base64url, signature);
};

export type Settled =
  /** A signed-in browser bound a pairing to this intent. **Not consent** — D19 is next. */
  | { readonly status: "bound"; readonly pairing: BoundPairing }
  /** The bound pairing has already produced a device, so there is nothing left to redeem. */
  | { readonly status: "redeemed" }
  /** The server's final answer about this intent. `reason` is its own RFC 7807 `detail`,
   * which for the common case says only "no such pairing intent" — AT8 means it cannot say
   * whether the intent expired, never existed, or refused the signature. */
  | { readonly status: "refused"; readonly reason: string }
  /** This loop gave up: the intent's window closed, or the attempt backstop ran out. */
  | { readonly status: "expired" }
  /** The caller cancelled — a plugin unloading, most often. Distinct from `expired`,
   * because nobody is left to be told about this one. */
  | { readonly status: "cancelled" };

/**
 * Poll `…/challenge` + `…/result` until the browser step completes, the intent's window
 * closes, or the caller gives up.
 *
 * **`unbound` is the normal answer**, not an error: between the browser opening and a human
 * finishing, every attempt returns it. The loop is bounded twice — by
 * `state.expiresAt`, which is the control plane's own clock and therefore the budget that
 * survives a cold launch, and by {@link MAX_ATTEMPTS} as a backstop against a device whose
 * clock never reaches the deadline.
 *
 * **The deadline is what makes the challenge cap safe across restarts.** The server counts
 * challenges per intent for the intent's whole life, not per run, so a fresh ten-minute
 * budget after every cold launch would exhaust it and 429 a pairing the user was still
 * completing. Counting down to a fixed instant cannot.
 *
 * **Nothing is persisted or adopted here.** This function is handed a `PairingState` value
 * and never a `PairingStore`: retrieving a result is not acting on one, and D19's
 * confirmation (Task 22) is what turns one into the other.
 *
 * `now` is injected, defaulted to the wall clock. This is the plugin's only clock read, and
 * it is injected for the reason `clippy.toml` forbids `Instant::now()` on the Rust side: a
 * test that cannot move time either sleeps for real or asserts nothing about a budget.
 */
export const retrieveWhenBound = async (
  controlplaneOrigin: string,
  state: PairingState,
  device: IntentSigner,
  signal: AbortSignal,
  options: {
    readonly intervalMs?: number;
    readonly maxAttempts?: number;
    readonly now?: () => number;
  } = {},
): Promise<Settled> => {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const now = options.now ?? (() => Date.now());

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs, signal);
    if (signal.aborted) return { status: "cancelled" };
    if (now() >= state.expiresAt) return { status: "expired" };

    const r = await retrieveOnce(controlplaneOrigin, state.intentId, device);

    if (signal.aborted) return { status: "cancelled" };
    if (!r.ok) {
      if (!r.retryable) return { status: "refused", reason: r.reason };
      continue;
    }
    if (r.value.state === "bound") return { status: "bound", pairing: r.value.pairing };
    if (r.value.state === "redeemed") return { status: "redeemed" };
    // `unbound`: the human is still in the browser. That is the expected answer.
  }
  return { status: "expired" };
};
