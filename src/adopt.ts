// **The last step before a device becomes real, and the only one a human takes on the
// device itself** (design §5.3, decisions D19 and D11).
//
//   pairing-intent.ts  --retrieveWhenBound--> {state:"bound", pairing_id, vault_id, assertion}
//                                                            |
//                                       *** a human on THIS device taps Connect ***
//                                                            |
//   this file           --retrieveOnce--> the SAME pairing_id and vault_id, a FRESH assertion
//                       (the assertion lives two minutes; the tap does not — see
//                        `AdoptionEffects.refresh`, and the ids are re-checked, not trusted)
//                                                            |
//   this file           --POST /v1/pairings/{id}/redeem {public_key, label, assertion}-->
//                       persist the vault id · seed the first upload · sign with it (PL4)
//
// **Why this exists.** Authenticating the READER of a response says nothing about who chose
// the ANSWER. `retrieveWhenBound` proves this device holds the private half of the key its
// own intent named — that is what lets it READ the result, and it is all it is. An attacker
// who wins D16's race binds a pairing to this intent first, and this plugin then
// legitimately reads a result naming the ATTACKER's vault. Without a human here the plugin
// adopts it, uploads the whole vault (`seedInitialUpload`) and, through PL3's authoritative
// snapshot, hands that vault delete authority over local files. Two drafts of this design
// died on exactly that sentence one level up; §5.3 records both.
//
// **What this does NOT do, and must never be sold as doing.** It does not let the user
// verify WHICH vault: in the attack the vault name is the attacker's to choose, and the
// retrieval carries an opaque vault id and no name at all. A displayed name or id is
// therefore not the defence and the copy below does not pretend it is. What the gate gives:
//
//   - adoption is never silent — nothing is persisted, redeemed or uploaded without a tap;
//   - in the attack the victim's browser showed a 409 for a choice they never completed, so
//     being asked here to connect a vault they never picked is a mismatch in front of a
//     human who has just seen an error;
//   - it converts a race the attacker wins invisibly into one they must also win in front
//     of the user.
//
// **The order is the property, so the order lives in one function.** `offerAdoption` takes
// every side effect as an injected {@link AdoptionEffects} rather than reaching for the
// plugin: a guard split across two files is a guard nobody can read, and `adopt.test.ts`'s
// first case is the whole point of this module.
//
// **Redemption lives here rather than beside the other hops** because it is precisely what
// the tap authorises. `pairing-intent.ts` holds the hops that happen BEFORE consent and
// deliberately touches no state at all; this file holds consent and everything downstream
// of it. (It is also the one function carried across from the deleted `pairing.ts`,
// minus its `code` — see below.)

import { type App, Modal, Setting } from "obsidian";
import { reasonFrom, request } from "./controlplane-http.ts";
import type { BoundPairing, RetrieveResult } from "./pairing-intent.ts";

/** What the user is being asked to agree to, and everything the redemption needs. */
export interface AdoptionOffer {
  /** From the D14 retrieval, and from nowhere else (D11). */
  readonly vaultId: string;
  readonly pairingId: string;
  /** This device's own name, repeated to the vault at redemption — the vault cannot look it
   * up anywhere else (`apps/vault/src/http/routes/pairing.rs`'s `RedeemBody.label`). */
  readonly deviceLabel: string;
  /** The Obsidian vault whose notes are about to be shared — `app.vault.getName()`. */
  readonly obsidianVaultName: string;
}

/** What a user is shown before they tap. Pure, and separate from the modal that renders it,
 * so the claims this plugin makes to a human are assertable without a DOM. */
export interface AdoptionCopy {
  readonly title: string;
  readonly body: readonly string[];
  readonly confirmText: string;
  readonly cancelText: string;
}

/**
 * **Be honest about what the tap does and does not prove** (§5.3).
 *
 * The grant is stated in words — full read and write, including deletion — because that is
 * the fact the user is agreeing to, and because an attacker-influenced label cannot carry
 * that weight. The vault id is shown as an *identifier*, not as identification: D12 exists
 * because `a3f0c1…` versus `7b21ee…` is not an informed choice, and this side has no name
 * for it at all (`POST …/result` returns `vault_id` and nothing else).
 *
 * The line that actually does work is the last one. In the attack the victim's browser
 * showed a 409 for a choice they never completed, so "cancel if you did not just finish
 * this in your browser" is a question they can answer from what they have just seen.
 */
export const adoptionCopy = (offer: AdoptionOffer): AdoptionCopy => ({
  title: "Connect this device?",
  body: [
    `Connect the Obsidian vault "${offer.obsidianVaultName}" to the Ctrl Notes vault you ` +
      `just chose in your browser.`,
    "That vault gets full read and write access to these notes: it can add files here, " +
      "change them, and delete them.",
    "This device cannot check which vault this is. It only knows the id " +
      `${offer.vaultId}. If you did not just finish connecting this device in your ` +
      "browser, or your browser showed an error, cancel.",
  ],
  confirmText: "Connect",
  cancelText: "Cancel",
});

/**
 * The tap itself, as a seam.
 *
 * `main.ts` holds one of these and defaults it to {@link askToAdopt}; a test replaces it,
 * because a real `Modal` needs a DOM the suite does not have. **A seam, not a policy knob** —
 * nothing in the shipped plugin sets it to anything that answers on a human's behalf.
 */
export type ConfirmAdoption = (offer: AdoptionOffer) => Promise<boolean>;

/**
 * The real modal.
 *
 * **Dismissal is a refusal.** Escape, the X and a click outside all reach `onClose` and
 * nothing else. A promise left unsettled there hangs the pairing flow for the life of the
 * session; one resolved `true` there makes a dismissal into a consent, which is the whole
 * property this file exists for. So `onClose` resolves `false` unless a button already
 * answered.
 *
 * **A named gap, the same one `openInSystemBrowser` declares**: how this looks and behaves
 * on a real host is checked by manual acceptance on each platform. What the tests hold is
 * the part that is behaviour rather than layout — which strings the user is shown, and what
 * each of the three exits resolves to.
 */
class AdoptionModal extends Modal {
  #answered = false;

  constructor(
    app: App,
    private readonly offer: AdoptionOffer,
    private readonly settle: (yes: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const copy = adoptionCopy(this.offer);
    this.titleEl.setText(copy.title);
    for (const line of copy.body) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(copy.cancelText).onClick(() => this.answer(false)),
      )
      .addButton((button) =>
        button.setButtonText(copy.confirmText).onClick(() => this.answer(true)),
      );
  }

  override onClose(): void {
    this.answer(false);
  }

  private answer(yes: boolean): void {
    if (this.#answered) return;
    this.#answered = true;
    this.settle(yes);
    this.close();
  }
}

/** Open the modal and resolve with the human's answer. Never rejects: a pairing flow that
 * throws here would leave a live intent and no way to finish it. */
export const askToAdopt = (app: App, offer: AdoptionOffer): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    new AdoptionModal(app, offer, resolve).open();
  });

export interface Redeemed {
  readonly deviceId: string;
}

export type RedeemResult =
  | { readonly ok: true; readonly value: Redeemed }
  | { readonly ok: false; readonly reason: string };

/**
 * `POST /v1/pairings/{id}/redeem` — spend the pairing, carrying this device's own public
 * key and the assertion the D14 retrieval returned.
 *
 * **There is no `code` field, and there must never be one again** (D20).
 * `0008_pairings.sql:8` says the plaintext is "stored as a SHA-256 hash, never in the
 * clear", so nothing could ever have handed a device one to send. What authorises this is
 * the `pra2` assertion, checked at the control plane together with the key it was minted
 * for — an assertion alone, presented with a foreign key, would still register a device —
 * and re-checked independently at the vault.
 *
 * **`publicKeyStandardBase64`, not `DeviceIdentity.publicKeyBase64`.** This surface decodes
 * with base64 STANDARD on both legs, while the three intent hops are `URL_SAFE_NO_PAD`
 * (design §8, "Encodings, pinned"). Callers build this argument with `device.ts`'s
 * `publicKeyStandardBase64`; the plugin's own base64url form of the same key fails to
 * decode there for most keys.
 *
 * The control plane parses only `public_key` and `assertion` and then replays the ORIGINAL
 * request bytes to the vault untouched (§8.2) — which is what lets `label` reach the
 * vault's own `RedeemBody` even though the control plane's copy of that struct never
 * declares it.
 */
export const redeemPairing = async (
  controlplaneOrigin: string,
  pairingId: string,
  publicKeyStandardBase64: string,
  label: string,
  assertion: string,
): Promise<RedeemResult> => {
  const path = `/v1/pairings/${encodeURIComponent(pairingId)}/redeem`;
  const r = await request(controlplaneOrigin, path, "POST", {
    public_key: publicKeyStandardBase64,
    label,
    assertion,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const { status, body } = r.value;
  if (status < 200 || status >= 300) return { ok: false, reason: reasonFrom(status, body) };
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "unexpected_response" };
  }
  const { device_id } = body as { device_id?: unknown };
  if (typeof device_id !== "string" || device_id === "") {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: true, value: { deviceId: device_id } };
};

/**
 * Everything {@link offerAdoption} is allowed to do, injected.
 *
 * Injected rather than reached for, so that the ordering guarantee is one readable function
 * and a test can watch every effect that a premature one would trip. The plugin supplies
 * all six; nothing here knows what a plugin is.
 */
export interface AdoptionEffects {
  /** D19's tap. */
  readonly confirm: ConfirmAdoption;
  /**
   * Re-run the D14 retrieval — `pairing-intent.ts`'s `retrieveOnce`, with the origin, this
   * device's intent id and its signer already bound in.
   *
   * **Because the tap sits between minting an assertion and spending it.** The control
   * plane's `ASSERTION_TTL_MS` is two minutes and its stated reason is a poll "every few
   * seconds", which stopped being the whole story the moment D19 put a human in the middle:
   * a user who reads the dialog, thinks about it, and taps three minutes later would
   * otherwise redeem with a credential the vault has already stopped accepting, and lose
   * the pairing to a refusal that is nobody's fault. Re-reading costs one challenge and
   * mints a fresh assertion.
   */
  readonly refresh: () => Promise<RetrieveResult>;
  /** {@link redeemPairing}, with the origin and this device's key already bound in. */
  readonly redeem: (offer: AdoptionOffer, assertion: string) => Promise<RedeemResult>;
  /** Write the adopted vault id and the new device id where this device will read them
   * again after a restart. */
  readonly persist: (vaultId: string, deviceId: string) => Promise<void>;
  /** Mark the whole vault dirty, so a freshly connected device actually pushes what it
   * already has (`main.ts`'s own note: Obsidian's `create` replay fires once, on load). */
  readonly seedInitialUpload: () => void;
  /** Drop the persisted pairing intent — this device is no longer waiting on it. */
  readonly forgetIntent: () => void;
  /**
   * Is the plugin still loaded? `requestUrl` has no abort and a modal can be answered long
   * after `onunload`, so a response already on the wire still lands — the same funnel
   * `main.ts` puts every other late completion through.
   */
  readonly stillActive: () => boolean;
}

export type AdoptionOutcome =
  | { readonly status: "adopted"; readonly vaultId: string; readonly deviceId: string }
  /** The human said no. Nothing was written, and the intent is gone. */
  | { readonly status: "declined" }
  /** Bound, but the control plane minted no assertion (O2 — a control plane built with no
   * signing key; production has one since 2026-09-09), so this pairing cannot be redeemed
   * by anyone. No human was asked. */
  | { readonly status: "unredeemable" }
  /**
   * The re-read after the tap named a different pairing or a different vault than the one
   * the human was shown. **Nothing is redeemed**, and the intent is dropped.
   *
   * This is the exact class of bug D19 exists to close, arriving one hop later: consent
   * given for `vault-a` must not spend itself on `vault-b`, however that substitution
   * happened. The intent goes because a device that has just been asked to redeem something
   * other than what its user agreed to has no business quietly polling the same intent
   * again — the recovery is the one the user already knows, press Pair.
   */
  | { readonly status: "mismatch" }
  /** The redemption itself was refused. Nothing was written; the intent is kept. */
  | { readonly status: "failed"; readonly reason: string }
  /** The plugin was unloaded while this was in flight. Nobody is left to tell. */
  | { readonly status: "abandoned" };

export interface AdoptionRequest {
  readonly pairing: BoundPairing;
  readonly deviceLabel: string;
  readonly obsidianVaultName: string;
}

/**
 * Spec D19. Ask the user, in Obsidian, and act only on a yes.
 *
 * **The first statement is the guard.** Every line below the `await effects.confirm(...)`
 * is an effect that must not happen without it, and every line above it must stay free of
 * one. Moving `redeem`, `persist` or `seedInitialUpload` above that await is the mutation
 * `adopt.test.ts`'s first case exists to catch.
 *
 * **The vault id is the one the response named** (D11), passed straight through. This
 * function does not choose it, cannot verify it, and does not pretend to — see the module
 * comment for what the human's tap actually buys.
 */
export async function offerAdoption(
  req: AdoptionRequest,
  effects: AdoptionEffects,
): Promise<AdoptionOutcome> {
  const { pairing } = req;
  // Before the human, not after: a consent collected for something that cannot complete
  // teaches the user that this dialog does not mean anything. `null` here is a control
  // plane with no signing key, which is every deployment today (O2).
  if (pairing.assertion === null) return { status: "unredeemable" };

  const offer: AdoptionOffer = {
    vaultId: pairing.vaultId,
    pairingId: pairing.pairingId,
    deviceLabel: req.deviceLabel,
    obsidianVaultName: req.obsidianVaultName,
  };

  // ---- Nothing above this line writes, redeems or uploads. Nothing below runs without it.
  const confirmed = await effects.confirm(offer);
  if (!effects.stillActive()) return { status: "abandoned" };
  if (!confirmed) {
    // "Declining leaves no trace and does not half-pair": the intent goes, so a reload does
    // not resume a poll for something the user has already refused.
    effects.forgetIntent();
    return { status: "declined" };
  }

  // **Re-read, then redeem what was just read.** The assertion in `pairing` was minted
  // before the modal opened and lives two minutes; the human's tap has no deadline. See
  // {@link AdoptionEffects.refresh}.
  const fresh = await effects.refresh();
  if (!effects.stillActive()) return { status: "abandoned" };
  // Kept on a failed re-read for the same reason a failed redemption keeps it: a transport
  // hiccup here is not this pairing being refused, and the user's own Pair press is a
  // better recovery than a device that has silently forgotten what it was doing.
  if (!fresh.ok) return { status: "failed", reason: fresh.reason };
  if (fresh.value.state !== "bound") {
    return { status: "failed", reason: `pairing_${fresh.value.state}` };
  }
  const current = fresh.value.pairing;
  // **The consent is for these two ids and no others.** Without this the re-read is a way
  // to redeem something the human never saw — which would be worse than the stale assertion
  // it was added to fix.
  if (current.pairingId !== offer.pairingId || current.vaultId !== offer.vaultId) {
    effects.forgetIntent();
    return { status: "mismatch" };
  }
  if (current.assertion === null) return { status: "failed", reason: "assertion_missing" };

  const redeemed = await effects.redeem(offer, current.assertion);
  if (!effects.stillActive()) return { status: "abandoned" };
  // The intent is deliberately KEPT here, and what that buys is a truthful message rather
  // than a recovery: a refusal may be a lost response to a redemption that did happen, and
  // the next retrieval says "redeemed" instead of leaving the device unable to tell that
  // from an intent that never existed. It cannot resume the pairing — the redeemed result
  // carries no `device_id` — so `main.ts` reports it and stops (see its `redeemed` arm).
  if (!redeemed.ok) return { status: "failed", reason: redeemed.reason };

  effects.forgetIntent();
  await effects.persist(pairing.vaultId, redeemed.value.deviceId);
  effects.seedInitialUpload();
  return { status: "adopted", vaultId: pairing.vaultId, deviceId: redeemed.value.deviceId };
}
