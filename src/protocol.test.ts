import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleProtocol, PAIRED_ACTIONS, type ProtocolOutcome } from "./protocol.ts";
import { Plugin, protocolHandlers } from "./testing/fake-obsidian.ts";

/** What Obsidian puts on every dispatch, whatever the URL said. */
const ACTION = "ctrlnotes/paired";

/** This device's Obsidian vault, as `app.vault.getName()` would answer it. */
const MINE = "Work Notes";

beforeEach(() => {
  protocolHandlers.clear();
});

describe("the obsidian:// callback", () => {
  /**
   * D15, asserted as an absence. Three drafts died because this URL carried something worth
   * stealing — a device code, then a nonce and a key hash — and each time the reasoning was
   * that the scheme is hard enough to claim. It is not: `obsidian://` is a namespace any
   * installed app can register for.
   *
   * `usedParams` is RECORDED, not declared: `handleProtocol` reads the parameters through a
   * proxy that notes every key touched. So this assertion fails the moment an arm reads
   * anything else, which a hand-maintained list could never do.
   */
  it("acts on no credential from the callback", () => {
    const handled = handleProtocol(
      { action: ACTION, vault: MINE, code: "stolen", pair: "p1" },
      MINE,
    );

    expect(handled.usedParams).toEqual(["vault"]);
    expect(handled.action).toBe("nudge");
  });

  /**
   * The same rule stated from the other end: whatever arrives, nothing arrives WITH it. A
   * callback value that reached the caller would be a value the caller could act on, and a
   * scheme a stranger can claim would then be choosing it.
   */
  it("can only make a poll run sooner: the outcome carries nothing from the callback", () => {
    const handled = handleProtocol(
      {
        action: ACTION,
        vault: MINE,
        code: "stolen-code",
        assertion: "stolen-assertion",
        vault_id: "stolen-vault",
        pairing_id: "stolen-pairing",
      },
      MINE,
    );

    expect(Object.keys(handled).sort()).toEqual(["action", "usedParams"]);
    const carried = JSON.stringify(handled);
    for (const secret of ["stolen-code", "stolen-assertion", "stolen-vault", "stolen-pairing"]) {
      expect(carried).not.toContain(secret);
    }
  });

  /**
   * A callback for a different Obsidian vault is not ours. Obsidian consumes `?vault=` to
   * pick the window, which is why it is on the URL at all (design §5.2).
   *
   * **This is housekeeping, not a control**, and the comment says so because the file it
   * is adapted from means something else by the same word: an earlier prototype's `wrong-vault` arm is
   * about Obsidian having switched vaults under a link id it holds. A nudge carries
   * nothing, so ignoring one denies an attacker nothing either.
   */
  it("ignores a callback naming another obsidian vault", () => {
    const handled = handleProtocol({ action: ACTION, vault: "Someone Else" }, MINE);

    expect(handled.action).toBe("ignore");
    expect(handled.usedParams).toEqual(["vault"]);
  });

  /**
   * The desktop main process uses `?vault=` to pick the window and then deletes it (design
   * §5.2), so the ordinary desktop dispatch arrives with no vault name at all. Reading
   * absence as "not ours" would make the deep link dead on the platform it exists for.
   */
  it("nudges when Obsidian's dispatch has already consumed the vault name", () => {
    const handled = handleProtocol({ action: ACTION }, MINE);

    expect(handled.action).toBe("nudge");
  });

  /**
   * The absence, as a property rather than as four examples. An arm added later that reads
   * `params.code` fails here even if nobody thought to write the example for it.
   */
  it("reads no parameter but vault, whatever arrives", () => {
    const key = fc.oneof(
      fc.constantFrom("vault", "action", "code", "pair", "assertion", "vault_id", "i"),
      fc.string({ minLength: 1, maxLength: 8 }),
    );

    fc.assert(
      fc.property(
        fc.dictionary(key, fc.string({ maxLength: 12 }), { maxKeys: 8 }),
        fc.string({ maxLength: 12 }),
        (params, myVaultName) => {
          const handled = handleProtocol(params, myVaultName);
          expect(["nudge", "ignore"]).toContain(handled.action);
          expect(handled.usedParams.filter((k) => k !== "vault")).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/**
 * **Which action string Obsidian dispatches `obsidian://ctrlnotes/paired` under is not
 * knowable from here.** `obsidian.d.ts` documents only single-segment examples ("'open'
 * corresponds to `obsidian://open`"), the real dispatch lives inside a closed-source app,
 * and this suite runs on Node. So both readings of the spec's URL are claimed, and this
 * test is what keeps the constant honest against §5.2's URL rather than against memory.
 */
describe("the actions this plugin claims", () => {
  it("covers both ways the spec's callback URL can be read", () => {
    const url = new URL("obsidian://ctrlnotes/paired?vault=Work%20Notes");

    expect(PAIRED_ACTIONS).toContain(url.hostname);
    expect(PAIRED_ACTIONS).toContain(`${url.hostname}${url.pathname}`);
  });
});

/**
 * The delivery mechanism `main.ts` is wired into. Registration is not this module's
 * job, but a handler that never arrives and a handler that outlives its plugin are both
 * failures of this file's contract, and neither is visible from `handleProtocol` alone.
 */
describe("the fake's obsidian:// dispatch", () => {
  class Probe extends Plugin {
    readonly seen: ProtocolOutcome[] = [];

    override onload(): void {
      for (const action of PAIRED_ACTIONS) {
        this.registerObsidianProtocolHandler(action, (params) => {
          this.seen.push(handleProtocol(params, MINE));
        });
      }
    }
  }

  const probes: Probe[] = [];
  const loaded = (): Probe => {
    const probe = new Probe({}, {});
    probe.load();
    probes.push(probe);
    return probe;
  };

  afterEach(() => {
    while (probes.length > 0) probes.pop()?.unload();
  });

  it("delivers a URI to the handler the plugin registered", () => {
    const probe = loaded();

    protocolHandlers.get(ACTION)?.({ action: ACTION, vault: MINE });

    expect(probe.seen).toEqual([{ action: "nudge", usedParams: ["vault"] }]);
  });

  /**
   * A handler outliving its plugin would nudge a poll that was cancelled when the plugin
   * unloaded, from a closure holding a torn-down instance. Obsidian unregisters on unload;
   * the fake has to, or a test can never see the difference.
   */
  it("stops delivering once the plugin unloads", () => {
    const probe = loaded();

    probes.pop()?.unload();

    // There is nothing left to deliver to: Obsidian would route the callback nowhere.
    expect(protocolHandlers.get(ACTION)).toBeUndefined();
    expect(protocolHandlers.size).toBe(0);
    expect(probe.seen).toEqual([]);
  });
});
