import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";
import type { SettingsHost } from "./settings-tab.ts";
import { CtrlNotesSettingsTab } from "./settings-tab.ts";
import { IDLE_STATUS, type SyncStatus } from "./sync/status.ts";
import { registerTab } from "./testing/fake-obsidian.ts";

/** The slice of the plugin the tab reads, plus a visible listener set — adapted from
 * glass-1's own `settings-status.test.ts`: same lifecycle claim, our fields. */
const fakeHost = (): { host: Plugin & SettingsHost; listeners: Set<(s: SyncStatus) => void> } => {
  const listeners = new Set<(s: SyncStatus) => void>();
  const host = {
    controlplaneOrigin: "https://cp.ctrlrouter.test",
    webAppOrigin: "https://app.ctrlrouter.test",
    vaultId: "vault-1",
    deviceId: "dev-1",
    pairingInFlight: false,
    vaultName: "My Vault",
    setControlplaneOrigin: async () => {},
    setWebAppOrigin: async () => {},
    startPairing: async () => {},
    disconnect: async () => {},
    syncStatus: () => IDLE_STATUS,
    onStatusChange: (fn: (s: SyncStatus) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onPairingChange: () => () => {},
    // `Plugin.register` — the tab hands it the pairing subscription to own.
    register: () => {},
  };
  return { host: host as unknown as Plugin & SettingsHost, listeners };
};

describe("CtrlNotesSettingsTab status subscription", () => {
  it("listens while shown and stops when hidden", () => {
    const { host, listeners } = fakeHost();
    const tab = registerTab(new CtrlNotesSettingsTab({} as import("obsidian").App, host));

    tab.display();
    expect(listeners.size).toBe(1);

    tab.hide();
    expect(listeners.size).toBe(0);
  });

  it("does not accumulate a listener per redraw", () => {
    // Obsidian keeps ONE tab instance and calls `display()` on every open — and the tab
    // redraws itself on pair, unpair and a pairing update too. Each redraw empties the
    // container, so a listener kept from the previous one writes into a dead element.
    const { host, listeners } = fakeHost();
    const tab = registerTab(new CtrlNotesSettingsTab({} as import("obsidian").App, host));

    tab.display();
    tab.display();
    tab.display();

    expect(listeners.size).toBe(1);
  });
});
