import type { App, Plugin } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingsHost } from "./settings-tab.ts";
import { CtrlNotesSettingsTab } from "./settings-tab.ts";
import { IDLE_STATUS } from "./sync/status.ts";
import {
  fakeTextComponents,
  registerTab,
  settingRows,
  settingsText,
} from "./testing/fake-obsidian.ts";

/**
 * The two origins this plugin cannot derive from anything else, and what the tab does to a
 * value on its way to the host.
 *
 * **Two, not one, and not three.** The control plane and the web app may be different hosts
 * (design §7), so neither is a derivation of the other and `startPairing` refuses up front
 * rather than sending a browser to a relative URL. The third field this file used to
 * cover — a typed vault id — is gone: the vault is chosen in the browser from the vaults
 * that session owns (D9/D11) and adopted here after a human confirms it (D19), so a text
 * box for it could only ever be wrong.
 */
const fakeHost = (
  overrides: Partial<SettingsHost> = {},
): { host: Plugin & SettingsHost; calls: { controlplane: string[]; webApp: string[] } } => {
  const calls = { controlplane: [] as string[], webApp: [] as string[] };
  const host = {
    controlplaneOrigin: "",
    webAppOrigin: "",
    vaultId: "",
    deviceId: null,
    pairingInFlight: false,
    vaultName: "My Vault",
    setControlplaneOrigin: async (v: string) => {
      calls.controlplane.push(v);
    },
    setWebAppOrigin: async (v: string) => {
      calls.webApp.push(v);
    },
    startPairing: async () => {},
    disconnect: async () => {},
    syncStatus: () => IDLE_STATUS,
    onStatusChange: () => () => {},
    onPairingChange: () => () => {},
    // `Plugin.register` — the tab hands it the pairing subscription to own.
    register: () => {},
    ...overrides,
  };
  return { host: host as unknown as Plugin & SettingsHost, calls };
};

afterEach(() => {
  fakeTextComponents.length = 0;
  settingRows.length = 0;
});

describe("the control-plane and web-app origin fields", () => {
  it("trims whitespace and a trailing slash off the control-plane origin", () => {
    const { host, calls } = fakeHost();
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    fakeTextComponents[0]?.type("  https://sync.ctrlnotes.app/  ");
    expect(calls.controlplane).toEqual(["https://sync.ctrlnotes.app"]);
    expect(calls.webApp).toEqual([]);
  });

  it("trims the web-app origin the same way, without touching the first field", () => {
    const { host, calls } = fakeHost();
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    fakeTextComponents[1]?.type("  https://ctrlnotes.app/  ");
    expect(calls.webApp).toEqual(["https://ctrlnotes.app"]);
    expect(calls.controlplane).toEqual([]);
  });

  // Obsidian draws the pane from the definitions its last `update()` cached, so the rows
  // that NAME the web app kept the old address after the field changed — reopening the
  // pane included. Changing the field re-reads the definitions.
  it("names the new web app in the pane's descriptions once the field changes", async () => {
    const { host } = fakeHost({ deviceId: "dev-1", webAppOrigin: "https://old.test" });
    host.setWebAppOrigin = async (v: string) => {
      (host as { webAppOrigin: string }).webAppOrigin = v;
    };
    const tab = registerTab(new CtrlNotesSettingsTab({} as App, host));
    tab.display();

    fakeTextComponents[1]?.type("https://new.test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    tab.hide();
    settingRows.length = 0;
    tab.display();

    expect(settingsText()).toMatch(/https:\/\/new\.test/);
    expect(settingsText()).not.toMatch(/https:\/\/old\.test/);
  });

  it("shows what the host already holds, on open", () => {
    const { host } = fakeHost({
      controlplaneOrigin: "https://sync.test",
      webAppOrigin: "https://app.test",
    });
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(fakeTextComponents[0]?.value).toBe("https://sync.test");
    expect(fakeTextComponents[1]?.value).toBe("https://app.test");
  });

  /** D11: a vault id is adopted, never typed. A box for it is not merely useless — a value
   * a user typed here is what `SyncSocket` would sign every challenge for (rule 3), so a
   * typo is an opaque "not authorised" with nothing on the wire able to correct it. */
  it("offers no vault-id field at all", () => {
    const { host } = fakeHost();
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(fakeTextComponents).toHaveLength(2);
    expect(settingsText()).not.toMatch(/vault id/i);
  });

  /** Design §7: the plugin's calls are made by the plugin, not a browser, so they must go
   * to the hostname that does NOT sit behind the Cloudflare Worker. The field's own
   * description is the only place a user is ever told that. */
  it("says the control-plane origin is the direct hostname, not the web app's", () => {
    const { host } = fakeHost();
    registerTab(new CtrlNotesSettingsTab({} as App, host)).display();

    expect(settingsText()).toMatch(/sync\.ctrlnotes\.app/);
  });
});
