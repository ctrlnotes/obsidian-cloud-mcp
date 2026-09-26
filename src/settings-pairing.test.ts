import type { App, Plugin } from "obsidian";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SettingsHost } from "./settings-tab.ts";
import { CtrlNotesSettingsTab } from "./settings-tab.ts";
import { IDLE_STATUS } from "./sync/status.ts";
import { buttons, registerTab, settingRows, settingsText } from "./testing/fake-obsidian.ts";
import { settingsHostDefaults } from "./testing/fake-settings-host.ts";

/**
 * The pane's half of design §5 and §6.3 — what a user can press, and what they are told
 * before and after they press it.
 *
 * **Rewritten for the intent flow, not adapted.** The previous revision drove
 * `pendingPairing` and a "Code: abc123" row, both of which are gone: there is no code
 * (rule 5), the browser is where a pairing is confirmed, and the vault is CHOSEN there
 * rather than typed here (D9/D11). Every case below is about the flow that replaced it.
 */
/** The two spies as plain properties, so an assertion reads a function value rather than
 * detaching a method (`@typescript-eslint/unbound-method`). */
type Spies = { readonly spies: { startPairing: Mock; disconnect: Mock } };

const fakeHost = (overrides: Partial<SettingsHost> = {}): Plugin & SettingsHost & Spies => {
  const startPairing = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});
  const host = {
    controlplaneOrigin: "https://sync.ctrlrouter.test",
    webAppOrigin: "https://app.ctrlrouter.test",
    vaultId: "",
    deviceId: null,
    pairingInFlight: false,
    vaultName: "My Vault",
    setControlplaneOrigin: async () => {},
    setWebAppOrigin: async () => {},
    startPairing,
    disconnect,
    syncStatus: () => IDLE_STATUS,
    onStatusChange: () => () => {},
    onPairingChange: () => () => {},
    // `Plugin.register` — the tab hands it the pairing subscription to own.
    register: () => {},
    ...settingsHostDefaults(),
    ...overrides,
    spies: { startPairing, disconnect },
  };
  return host as unknown as Plugin & SettingsHost & Spies;
};

afterEach(() => {
  buttons.length = 0;
  settingRows.length = 0;
});

describe("pairing this device", () => {
  it("offers a Pair button, disabled until both origins are set", () => {
    const host = fakeHost({ controlplaneOrigin: "", webAppOrigin: "" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    const pair = buttons.find((b) => b.text === "Pair");
    expect(pair).toBeDefined();
    pair?.click();
    expect(host.spies.startPairing).not.toHaveBeenCalled();
  });

  /**
   * **The condition that actually changed, and it was a bug**.
   * The old gate was `controlplaneOrigin && vaultId`, and under this flow the plugin does
   * not know a vault id before pairing and must not — the browser picks the vault from the
   * ones its own session owns (D9/D11). Left as it was, the Pair button was disabled
   * forever and the new flow was unreachable from the UI.
   */
  it("stays disabled with only the control plane set, because the browser is where a vault is chosen", () => {
    const host = fakeHost({ webAppOrigin: "" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    buttons.find((b) => b.text === "Pair")?.click();
    expect(host.spies.startPairing).not.toHaveBeenCalled();
  });

  it("enables Pair with both origins set, and never asks for a vault id first", () => {
    const host = fakeHost();
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    buttons.find((b) => b.text === "Pair")?.click();
    expect(host.spies.startPairing).toHaveBeenCalledWith("My Vault");
  });

  /** Rule 5, in the one place a user could still have seen a code. */
  it("never shows a pairing code", () => {
    const host = fakeHost({ pairingInFlight: true });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(settingsText()).not.toMatch(/\bcode\b/i);
  });

  it("shows a waiting row instead of the Pair button while a pairing is in flight", () => {
    const host = fakeHost({ pairingInFlight: true });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(buttons.find((b) => b.text === "Pair")).toBeUndefined();
    expect(settingsText()).toMatch(/browser/i);
  });

  /**
   * A cold-launch resume (D13) and an `obsidian://` nudge (D15) both start a pairing with
   * nobody having pressed anything, so the pane has to react from the face that shows the
   * Pair button too — not only from the waiting row. Armed inside one branch, this pane sat
   * there offering "Pair" for a device that was already pairing.
   */
  it("redraws when a pairing starts that the user did not press Pair for", () => {
    const box: { onChange: (() => void) | null } = { onChange: null };
    const host = fakeHost({
      pairingInFlight: false,
      onPairingChange: (cb: () => void) => {
        box.onChange = cb;
        return () => {
          box.onChange = null;
        };
      },
    });
    const tab = registerTab(new CtrlNotesSettingsTab({} as App, host));
    tab.display();
    (tab.containerEl as unknown as { isConnected: boolean }).isConnected = true;

    const displaySpy = vi.spyOn(tab, "display");
    box.onChange?.();
    expect(displaySpy).toHaveBeenCalled();
  });

  it("redraws when the pairing changes, if the pane is still open", () => {
    const box: { onChange: (() => void) | null } = { onChange: null };
    const host = fakeHost({
      pairingInFlight: true,
      onPairingChange: (cb: () => void) => {
        box.onChange = cb;
        return () => {
          box.onChange = null;
        };
      },
    });
    const tab = registerTab(new CtrlNotesSettingsTab({} as App, host));
    tab.display();
    // The real `containerEl` is an `HTMLElement`, whose `isConnected` DOM property is
    // typed `readonly` — the fake's is a plain mutable field at runtime (`fake-obsidian.ts`
    // stands the whole element in with a bare object), so this cast is the same "type
    // against the real API, drive the fake" split every fake-backed test in this plugin
    // makes.
    (tab.containerEl as unknown as { isConnected: boolean }).isConnected = true;

    const displaySpy = vi.spyOn(tab, "display");
    box.onChange?.();
    expect(displaySpy).toHaveBeenCalled();
  });
});

describe("the waiting face", () => {
  it("offers to open the browser again, and to cancel", () => {
    const reopen = vi.fn(() => true);
    const cancel = vi.fn();
    const host = fakeHost({
      pairingInFlight: true,
      reopenPairingPage: reopen,
      cancelPairing: cancel,
    });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    buttons.find((b) => b.text === "Open browser again")?.click();
    buttons.find((b) => b.text === "Cancel pairing")?.click();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("offers neither once the device is paired or idle", () => {
    registerTab(new CtrlNotesSettingsTab({} as App, fakeHost())).display();
    expect(buttons.map((b) => b.text)).not.toContain("Open browser again");
    expect(buttons.map((b) => b.text)).not.toContain("Cancel pairing");
  });

  it("styles Pair as the pane's primary action", () => {
    registerTab(new CtrlNotesSettingsTab({} as App, fakeHost())).display();
    expect(buttons.find((b) => b.text === "Pair")?.cta).toBe(true);
  });
});

describe("a connected device", () => {
  const VAULT = "e000518f8653638e404ca98c6d0a8f10";
  const DEVICE = "d41d8cd98f00b204e9800998ecf8427e";

  it("shows the adopted vault and device by short id, and never a Pair button", () => {
    const host = fakeHost({ deviceId: DEVICE, vaultId: VAULT });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(buttons.find((b) => b.text === "Pair")).toBeUndefined();
    const vault = settingRows.find((r) => r.name === "Vault");
    const device = settingRows.find((r) => r.name === "This device");
    expect(vault?.desc).toMatch(/^Vault ID /);
    expect(vault?.descEl.code).toEqual(["e000 518f…"]);
    expect(device?.desc).toMatch(/^Device ID /);
    expect(device?.descEl.code).toEqual(["d41d 8cd9…"]);
  });

  /**
   * **Spec §6.3, and the copy is the whole point.** No revoke path is reachable from the
   * plugin — hop 2 needs a browser-minted grant and the vault's own DELETE needs the
   * operator static token — so a button called "Unpair" beside a device list the user
   * cannot see reads as a revocation and is not one. The row's name and the sentence are
   * what stop a user believing they have cut a lost laptop off; the button no longer
   * repeats the row's name, and says with its ellipsis that it asks first.
   */
  it("names the row Disconnect this device, and the button Disconnect…, never Unpair", () => {
    const host = fakeHost({ deviceId: DEVICE, vaultId: VAULT });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(settingRows.map((r) => r.name)).toContain("Disconnect this device");
    const button = buttons.find((b) => b.text === "Disconnect…");
    expect(button?.destructive).toBe(true);
    expect(buttons.find((b) => /unpair/i.test(b.text))).toBeUndefined();
  });

  it("says the disconnect is local and points at the device list for a real revoke", () => {
    const host = fakeHost({ deviceId: DEVICE, vaultId: VAULT });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    const text = settingsText();
    expect(text).toMatch(/this device only/i);
    expect(text).toMatch(/device list/i);
    // The web app is WHERE that list is, so the sentence has to name it rather than say
    // "your device list" and leave the user hunting.
    expect(text).toContain("https://app.ctrlrouter.test");
  });

  it("asks first, and disconnects only on a yes", async () => {
    const host = fakeHost({ deviceId: DEVICE, vaultId: VAULT });
    const tab = registerTab(new CtrlNotesSettingsTab({} as App, host));
    const asked: string[] = [];
    let answer = false;
    tab.confirm = (copy) => {
      asked.push(copy.title);
      expect(copy.destructive).toBe(true);
      expect(copy.body.join(" ")).toMatch(/device list/i);
      return Promise.resolve(answer);
    };
    tab.display();

    buttons.find((b) => b.text === "Disconnect…")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(["Disconnect this device?"]);
    expect(host.spies.disconnect).not.toHaveBeenCalled();

    answer = true;
    buttons.find((b) => b.text === "Disconnect…")?.click();
    await vi.waitFor(() => expect(host.spies.disconnect).toHaveBeenCalledTimes(1));
  });

  /** The real modal, through the default seam: dismissal is a no, and its confirm button is
   * styled as destructive. */
  it("uses a real confirmation modal by default", async () => {
    const host = fakeHost({ deviceId: DEVICE, vaultId: VAULT });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    buttons.find((b) => b.text === "Disconnect…")?.click();
    const confirm = buttons.find((b) => b.text === "Disconnect");
    expect(confirm?.destructive).toBe(true);
    // Cancel comes first, so it keeps the modal's default focus.
    expect(buttons.map((b) => b.text).slice(-2)).toEqual(["Cancel", "Disconnect"]);
    confirm?.click();
    await vi.waitFor(() => expect(host.spies.disconnect).toHaveBeenCalledTimes(1));
  });
});
