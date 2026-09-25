import type { App, Plugin } from "obsidian";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SettingsHost } from "./settings-tab.ts";
import { CtrlNotesSettingsTab } from "./settings-tab.ts";
import { IDLE_STATUS } from "./sync/status.ts";
import { buttons, registerTab, settingRows, settingsText } from "./testing/fake-obsidian.ts";

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

describe("a connected device", () => {
  it("shows the adopted vault and device, and never a Pair button", () => {
    const host = fakeHost({ deviceId: "dev-abc", vaultId: "vault-1" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(buttons.find((b) => b.text === "Pair")).toBeUndefined();
    expect(settingsText()).toContain("dev-abc");
    expect(settingsText()).toContain("vault-1");
  });

  /**
   * **Spec §6.3, and the copy is the whole point.** No revoke path is reachable from the
   * plugin — hop 2 needs a browser-minted grant and the vault's own DELETE needs the
   * operator static token — so a button called "Unpair" beside a device list the user
   * cannot see reads as a revocation and is not one. The name and the sentence are what
   * stop a user believing they have cut a lost laptop off.
   */
  it("calls the button Disconnect this device, never Unpair", () => {
    const host = fakeHost({ deviceId: "dev-abc", vaultId: "vault-1" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(buttons.find((b) => b.text === "Disconnect this device")).toBeDefined();
    expect(buttons.find((b) => b.text === "Unpair")).toBeUndefined();
  });

  it("says the disconnect is local and points at the device list for a real revoke", () => {
    const host = fakeHost({ deviceId: "dev-abc", vaultId: "vault-1" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    const text = settingsText();
    expect(text).toMatch(/this device only/i);
    expect(text).toMatch(/device list/i);
    // The web app is WHERE that list is, so the sentence has to name it rather than say
    // "your device list" and leave the user hunting.
    expect(text).toContain("https://app.ctrlrouter.test");
  });

  it("pressing Disconnect this device calls the host", async () => {
    const host = fakeHost({ deviceId: "dev-abc", vaultId: "vault-1" });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    buttons.find((b) => b.text === "Disconnect this device")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.spies.disconnect).toHaveBeenCalled();
  });
});
