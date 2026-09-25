// D19's gate, at the level where the ORDER is the whole property: nothing is redeemed,
// persisted or uploaded until a human on this device has said yes.
//
// The end-to-end version of these lives in `main.test.ts`, driving the real plugin through
// `startPairing`. This file holds the ordering itself, the arms `main.ts` only reports, and
// the copy — which is a claim made to a user and therefore worth pinning.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AdoptionEffects,
  adoptionCopy,
  askToAdopt,
  type ConfirmAdoption,
  offerAdoption,
} from "./adopt.ts";
import type { BoundPairing, RetrieveResult } from "./pairing-intent.ts";
import { buttons, openModals } from "./testing/fake-obsidian.ts";

afterEach(() => {
  buttons.length = 0;
  openModals.length = 0;
});

const bound = (overrides: Partial<BoundPairing> = {}): BoundPairing => ({
  pairingId: "pai_1",
  vaultId: "vault-1",
  assertion: "pra2.abc",
  ...overrides,
});

/** The ordinary answer to the post-tap re-read: the same pairing the modal showed, carrying
 * an assertion minted just now. That is what `retrieve_pairing_result` does on a second
 * bound read — it mints afresh and marks nothing spent. */
const freshlyBound = (pairing: BoundPairing): RetrieveResult => ({
  ok: true,
  value: { state: "bound", pairing: { ...pairing, assertion: "pra2.fresh" } },
});

interface Recorded {
  readonly steps: string[];
  readonly effects: AdoptionEffects;
  /** Every assertion `redeem` was handed, in order — the point of the re-read is WHICH. */
  readonly redeemedWith: string[];
  /** What the post-tap re-read answers. Set by {@link offered}. */
  refreshesWith(result: RetrieveResult): void;
  /** Answers the pending `confirm`, as a human tapping the modal would. */
  answer(yes: boolean): void;
}

/** Effects that record the order they were called in, and hold `confirm` open until a test
 * answers it — the shape the guard is actually about. */
const recorder = (overrides: Partial<AdoptionEffects> = {}): Recorded => {
  const steps: string[] = [];
  const redeemedWith: string[] = [];
  let settle: ((yes: boolean) => void) | null = null;
  let refreshed: RetrieveResult = freshlyBound(bound());
  const effects: AdoptionEffects = {
    confirm: () => {
      steps.push("confirm");
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    },
    refresh: async () => {
      steps.push("refresh");
      return refreshed;
    },
    redeem: async (_offer, assertion) => {
      steps.push("redeem");
      redeemedWith.push(assertion);
      return { ok: true, value: { deviceId: "dev-1" } };
    },
    persist: async () => {
      steps.push("persist");
    },
    seedInitialUpload: () => {
      steps.push("seed");
    },
    forgetIntent: () => {
      steps.push("forget");
    },
    stillActive: () => true,
    ...overrides,
  };
  return {
    steps,
    effects,
    redeemedWith,
    refreshesWith: (result) => {
      refreshed = result;
    },
    answer: (yes) => {
      settle?.(yes);
      settle = null;
    },
  };
};

const offered = (t: Recorded, pairing = bound(), refreshed?: RetrieveResult): Promise<unknown> => {
  t.refreshesWith(refreshed ?? freshlyBound(pairing));
  return offerAdoption(
    { pairing, deviceLabel: "My Laptop", obsidianVaultName: "My Vault" },
    t.effects,
  );
};

describe("nothing happens before the tap", () => {
  /** The guard. An attacker who wins D16's race gets a result this plugin may legitimately
   * READ; this is the only thing between that and the user's notes. */
  it("does not redeem, persist or upload while the confirmation is still open", async () => {
    const t = recorder();
    void offered(t);
    await Promise.resolve();
    await Promise.resolve();

    expect(t.steps).toEqual(["confirm"]);
  });

  /** The positive, and it is not optional: without it the guard above passes on a gate that
   * never adopts anything at all. */
  it("redeems, persists and seeds after the confirmation resolves, in that order", async () => {
    const t = recorder();
    const running = offered(t);
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({
      status: "adopted",
      vaultId: "vault-1",
      deviceId: "dev-1",
    });
    expect(t.steps).toEqual(["confirm", "refresh", "redeem", "forget", "persist", "seed"]);
  });

  it("passes the vault the response named, never one of its own", async () => {
    const seen: string[] = [];
    const t = recorder({
      persist: async (vaultId) => {
        seen.push(vaultId);
      },
    });
    const running = offered(t, bound({ vaultId: "vault-from-the-response" }));
    await Promise.resolve();
    t.answer(true);
    await running;

    expect(seen).toEqual(["vault-from-the-response"]);
  });
});

describe("declining leaves nothing behind", () => {
  it("forgets the intent and neither redeems nor persists", async () => {
    const t = recorder();
    const running = offered(t);
    await Promise.resolve();
    t.answer(false);

    await expect(running).resolves.toEqual({ status: "declined" });
    expect(t.steps).toEqual(["confirm", "forget"]);
  });
});

// ---------------------------------------------------------------------------------------
// The re-read between the tap and the redemption (minor fix).
//
// `ASSERTION_TTL_MS` is two minutes and its stated reason is "a poll every few seconds" —
// which stopped being true the moment D19 put a human in the middle. A user who leaves the
// dialog open loses the pairing to a credential that aged out behind it.
// ---------------------------------------------------------------------------------------
describe("the assertion spent is the one minted after the tap", () => {
  it("redeems with the re-read's assertion, not the one the modal was opened with", async () => {
    const t = recorder();
    const running = offered(t, bound({ assertion: "pra2.stale" }));
    await Promise.resolve();
    t.answer(true);
    await running;

    expect(t.redeemedWith).toEqual(["pra2.fresh"]);
  });

  /** **The half that makes the re-read safe rather than dangerous.** A second read is also
   * a second chance to be handed something else; consent was given for these two ids and
   * spending it on any others is the exact substitution D19 exists to refuse. */
  it("redeems nothing when the re-read names a different vault", async () => {
    const t = recorder();
    const running = offered(
      t,
      bound({ vaultId: "the-vault-the-user-saw" }),
      freshlyBound(bound({ vaultId: "somebody-elses-vault" })),
    );
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({ status: "mismatch" });
    // `forget`, and no `redeem`, `persist` or `seed` anywhere after it.
    expect(t.steps).toEqual(["confirm", "refresh", "forget"]);
  });

  it("redeems nothing when the re-read names a different pairing", async () => {
    const t = recorder();
    const running = offered(t, bound(), freshlyBound(bound({ pairingId: "pai_other" })));
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({ status: "mismatch" });
    expect(t.steps).toEqual(["confirm", "refresh", "forget"]);
  });

  /** A transport hiccup on the re-read is not this pairing being refused, so the intent
   * stays and the user's own Pair press is the recovery — the same posture a refused
   * redemption takes. */
  it("keeps the intent and redeems nothing when the re-read fails", async () => {
    const t = recorder();
    const running = offered(t, bound(), {
      ok: false,
      reason: "network_error",
      retryable: true,
    });
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({ status: "failed", reason: "network_error" });
    expect(t.steps).toEqual(["confirm", "refresh"]);
  });

  /** Somebody redeemed this pairing while the dialog was open. There is nothing left to
   * spend, and inventing an adoption from a state that carries no `device_id` is not a
   * recovery — `main.ts`'s `redeemed` arm says the same thing one level up. */
  it("redeems nothing when the pairing was spent while the dialog was open", async () => {
    const t = recorder();
    const running = offered(t, bound(), {
      ok: true,
      value: { state: "redeemed", pairingId: "pai_1", vaultId: "vault-1" },
    });
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({ status: "failed", reason: "pairing_redeemed" });
    expect(t.steps).toEqual(["confirm", "refresh"]);
  });
});

describe("the arms that never reach a human", () => {
  /** O2: no control plane has a signing key yet, so `assertion` is null on every real
   * deployment today. Asking for consent to something that cannot complete is worse than
   * saying so — and it must never be mistaken for a decline. */
  it("never asks when the bound pairing carries no assertion", async () => {
    const t = recorder();

    await expect(offered(t, bound({ assertion: null }))).resolves.toEqual({
      status: "unredeemable",
    });
    expect(t.steps).toEqual([]);
  });

  /** A refused redemption keeps the intent: the answer is still readable, and a retry is
   * the user's own Pair press rather than a silent half-pairing. */
  it("persists nothing and keeps the intent when the redemption is refused", async () => {
    const t = recorder({
      redeem: async () => {
        return { ok: false, reason: "this pairing has already been redeemed" };
      },
    });
    const running = offered(t);
    await Promise.resolve();
    t.answer(true);

    await expect(running).resolves.toEqual({
      status: "failed",
      reason: "this pairing has already been redeemed",
    });
    expect(t.steps).toEqual(["confirm", "refresh"]);
  });

  /** The lifecycle funnel `main.ts` already applies to every other late completion: a
   * modal can be answered after the plugin has been disabled, and `requestUrl` has no
   * abort, so a redemption already on the wire still lands. */
  it("adopts nothing when the plugin went away while the modal was open", async () => {
    let alive = true;
    const t = recorder({ stillActive: () => alive });
    const running = offered(t);
    await Promise.resolve();
    alive = false;
    t.answer(true);

    await expect(running).resolves.toEqual({ status: "abandoned" });
    expect(t.steps).toEqual(["confirm"]);
  });
});

describe("the copy is honest about what the tap does and does not prove", () => {
  const copy = adoptionCopy({
    vaultId: "vault-1",
    pairingId: "pai_1",
    deviceLabel: "My Laptop",
    obsidianVaultName: "My Vault",
  });
  const body = copy.body.join(" ");

  /** §5's rule for the browser's confirm page, and it applies here for the same reason: an
   * attacker-influenced label cannot carry the weight of what is being granted. */
  it("states the grant in words rather than leaning on a name", () => {
    expect(body).toMatch(/read and write/i);
    expect(body).toMatch(/delete/i);
  });

  /** §5.3: the gate must NOT be sold as letting the user verify which vault — in the attack
   * the vault name is the attacker's to choose. */
  it("says the device cannot check which vault this is", () => {
    expect(body).toMatch(/cannot (check|verify)/i);
  });

  /** The mismatch a victim is being asked to notice: their browser showed a 409 for a
   * choice they never completed. */
  it("tells the user to cancel if they did not just finish this in a browser", () => {
    expect(body).toMatch(/cancel/i);
    expect(body).toMatch(/browser/i);
  });

  it("names this Obsidian vault, so the user knows which one is being connected", () => {
    expect(body).toContain("My Vault");
  });
});

describe("the modal seam", () => {
  const app = {} as never;

  it("resolves true when the user presses Connect", async () => {
    const answered = askToAdopt(app, {
      vaultId: "vault-1",
      pairingId: "pai_1",
      deviceLabel: "My Laptop",
      obsidianVaultName: "My Vault",
    });
    buttons.find((b) => b.text === "Connect")?.click();
    await expect(answered).resolves.toBe(true);
  });

  /** **Closing IS declining.** Escape, the X, and a click outside all reach `onClose` and
   * nothing else — a promise left unsettled there would hang the pairing flow forever, and
   * resolving it `true` would make dismissal a consent. */
  it("declines when the modal is dismissed without a choice", async () => {
    const answered = askToAdopt(app, {
      vaultId: "vault-1",
      pairingId: "pai_1",
      deviceLabel: "My Laptop",
      obsidianVaultName: "My Vault",
    });
    openModals[0]?.close();
    await expect(answered).resolves.toBe(false);
  });

  it("closes itself once the user has answered", async () => {
    const answered = askToAdopt(app, {
      vaultId: "vault-1",
      pairingId: "pai_1",
      deviceLabel: "My Laptop",
      obsidianVaultName: "My Vault",
    });
    buttons.find((b) => b.text === "Cancel")?.click();
    await expect(answered).resolves.toBe(false);
    expect(openModals).toHaveLength(0);
  });

  it("renders the copy the user is being asked to read", () => {
    void askToAdopt(app, {
      vaultId: "vault-1",
      pairingId: "pai_1",
      deviceLabel: "My Laptop",
      obsidianVaultName: "My Vault",
    });
    const rendered = openModals[0]?.contentEl.texts.join(" ") ?? "";
    for (const line of adoptionCopy({
      vaultId: "vault-1",
      pairingId: "pai_1",
      deviceLabel: "My Laptop",
      obsidianVaultName: "My Vault",
    }).body) {
      expect(rendered).toContain(line);
    }
  });

  it("is typed as a ConfirmAdoption, so main.ts's seam and the real modal cannot drift", () => {
    const seam: ConfirmAdoption = (offer) => askToAdopt(app, offer);
    expect(vi.fn(seam)).toBeDefined();
  });
});
