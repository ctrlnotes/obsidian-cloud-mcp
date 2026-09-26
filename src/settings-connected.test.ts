import type { App, Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmCopy } from "./modals.ts";
import type { OverviewResult } from "./overview.ts";
import { CONNECT_CLAUDE_CODE, CtrlNotesSettingsTab, type SettingsHost } from "./settings-tab.ts";
import { IDLE_STATUS, type SyncStatus } from "./sync/status.ts";
import {
  buttons,
  openModals,
  registerTab,
  settingRows,
  settingsText,
} from "./testing/fake-obsidian.ts";
import { settingsHostDefaults } from "./testing/fake-settings-host.ts";

/**
 * The connected face of the pane, after the design audit: status first, identity by name,
 * the agents that can reach this vault, and the two addresses last under Advanced.
 */

const DAY = 86_400_000;
const NOW = 1_790_400_000_000;

const loaded = (agents: unknown[], name: string | null = "Work"): OverviewResult => ({
  status: "loaded",
  overview: {
    vault: { vault_id: "e000518f8653638e404ca98c6d0a8f10", name },
    agents: agents as never,
  },
});

interface Harness {
  readonly host: Plugin & SettingsHost;
  readonly overviewCalls: () => number;
  readonly opened: string[];
  readonly setStatus: (status: SyncStatus) => void;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly startPairing: ReturnType<typeof vi.fn>;
  readonly retrySyncing: ReturnType<typeof vi.fn>;
  /** Change which vault and device the host is paired with, and announce it the way the
   * plugin's `notifyPairingChange` does. */
  readonly repair: (vaultId: string, deviceId: string | null) => void;
}

const harness = (
  overrides: Partial<SettingsHost> = {},
  overview: () => Promise<OverviewResult> = () => Promise.resolve(loaded([])),
): Harness => {
  const listeners = new Set<(s: SyncStatus) => void>();
  let status: SyncStatus = { ...IDLE_STATUS, syncedCursor: 3 };
  let calls = 0;
  const opened: string[] = [];
  const disconnect = vi.fn(async () => {});
  const startPairing = vi.fn(async () => {});
  const retrySyncing = vi.fn(() => {});
  const pairingListeners = new Set<() => void>();
  const host = {
    controlplaneOrigin: "https://sync.test",
    webAppOrigin: "https://app.test",
    vaultId: "e000518f8653638e404ca98c6d0a8f10",
    deviceId: "d41d8cd98f00b204e9800998ecf8427e",
    pairingInFlight: false,
    vaultName: "My Vault",
    setControlplaneOrigin: async () => {},
    setWebAppOrigin: async () => {},
    startPairing,
    disconnect,
    syncStatus: () => status,
    onStatusChange: (fn: (s: SyncStatus) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onPairingChange: (fn: () => void) => {
      pairingListeners.add(fn);
      return () => {
        pairingListeners.delete(fn);
      };
    },
    register: () => {},
    ...settingsHostDefaults(),
    retrySyncing,
    now: () => NOW,
    openInBrowser: (url: string) => {
      opened.push(url);
    },
    loadOverview: () => {
      calls += 1;
      return overview();
    },
    ...overrides,
  };
  return {
    host: host as unknown as Plugin & SettingsHost,
    overviewCalls: () => calls,
    opened,
    setStatus: (next) => {
      status = next;
      for (const fn of [...listeners]) fn(next);
    },
    disconnect,
    startPairing,
    retrySyncing,
    repair: (vaultId, deviceId) => {
      Object.assign(host, { vaultId, deviceId });
      for (const fn of [...pairingListeners]) fn();
    },
  };
};

/** A tab registered, drawn, and connected, the way Obsidian holds an open pane. */
const open = (h: Harness): CtrlNotesSettingsTab => {
  const tab = registerTab(new CtrlNotesSettingsTab({} as App, h.host));
  (tab.containerEl as unknown as { isConnected: boolean }).isConnected = true;
  tab.display();
  return tab;
};

/** Let a resolved `loadOverview` land and the pane redraw. */
const landed = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Let the overview land, then look at the pane as it now stands — the records of earlier
 * draws dropped, since every redraw appends to them. */
const settled = async (tab: CtrlNotesSettingsTab): Promise<void> => {
  await landed();
  settingRows.length = 0;
  buttons.length = 0;
  tab.display();
};

const names = (): string[] => settingRows.map((r) => r.name);
const row = (name: string) => settingRows.find((r) => r.name === name);

afterEach(() => {
  buttons.length = 0;
  settingRows.length = 0;
  openModals.length = 0;
  vi.restoreAllMocks();
});

describe("the pane's order", () => {
  it("puts the status first and the two addresses last, under Advanced", async () => {
    await settled(open(harness()));

    const order = names();
    expect(order[0]).toBe("Sync");
    const advanced = order.indexOf("Advanced");
    expect(advanced).toBeGreaterThan(order.indexOf("Disconnect this device"));
    expect(order.slice(advanced)).toEqual(["Advanced", "Control plane", "Web app"]);
    expect(settingRows[advanced]?.heading).toBe(true);
  });

  it("keeps the facts in the shorter descriptions", () => {
    open(harness());
    expect(row("Control plane")?.desc).toMatch(/direct address/);
    expect(row("Web app")?.desc).toMatch(/sign in/);
  });

  it("puts Pair first on an unpaired device, and Advanced after it", () => {
    open(harness({ deviceId: null, vaultId: "" }));
    expect(names()).toEqual(["Pair this device", "Advanced", "Control plane", "Web app"]);
  });
});

describe("the status row", () => {
  it("draws a headline, then one line per count", () => {
    const h = harness();
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3, unsyncable: 2, refused: 1 });
    open(h);
    const sync = row("Sync");
    expect(sync?.descEl.texts.slice(0, 1)).toEqual(["Up to date."]);
    expect(sync?.desc).toContain("2 files are not synced");
    expect(sync?.desc).toContain("1 file was refused");
  });

  it("rewrites its words in place as the status changes", () => {
    const h = harness();
    open(h);
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3, pending: 5 });
    expect(row("Sync")?.desc).toBe("Syncing: 5 changes still to send.");
  });

  /** Item 5: the paths are held, so the pane lists them rather than pointing at a console. */
  it("offers Show files when a count is non-zero, listing each file with its reason", () => {
    const h = harness({
      skippedFiles: () => [
        { path: "big.pdf", kind: "oversize" },
        { path: "x.md", kind: "refused", detail: "too large" },
      ],
    });
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3, unsyncable: 1, refused: 1 });
    open(h);

    buttons.find((b) => b.text === "Show files")?.click();
    const modal = openModals[0];
    expect(modal?.contentEl.code).toEqual(["big.pdf", "x.md"]);
    expect(modal?.contentEl.texts.join(" ")).toContain("Refused by the server: too large.");
  });

  it("offers no Show files with nothing skipped", () => {
    open(harness());
    expect(buttons.map((b) => b.text)).not.toContain("Show files");
  });

  it("grows the button when a count first appears", () => {
    const h = harness();
    open(h);
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3, unavailable: 1 });
    expect(buttons.map((b) => b.text)).toContain("Show files");
  });
});

/** Item 3: a refused device must not read as connected, and must be offered the way back. */
describe("a refused session", () => {
  const refused: SyncStatus = { ...IDLE_STATUS, syncedCursor: 3, refusal: "not authorised" };
  /** What `socket.ts` makes of the same refusal met during a handshake. */
  const refusedOnConnect: SyncStatus = {
    ...refused,
    refusal: 'could not connect to vault "v": not authorised',
  };
  /** A refusal that is not about this device's registration at all. */
  const mismatched: SyncStatus = {
    ...IDLE_STATUS,
    syncedCursor: 3,
    refusal: "wire version 4 is not supported by this vault",
  };

  it("is drawn as a warning, and nothing on the pane says Connected", () => {
    const h = harness();
    h.setStatus(refused);
    open(h);

    expect(row("Sync")?.descEl.classes.has("mod-warning")).toBe(true);
    expect(settingsText()).not.toMatch(/\bconnected\b(?! to this vault)/i);
    expect(names()).not.toContain("Connected");
    // The honest copy about revocation is kept.
    expect(row("Sync")?.desc).toMatch(/removed from your vault's device list/);
  });

  it("offers Pair again for the revoked-elsewhere refusal, in either form", () => {
    for (const status of [refused, refusedOnConnect]) {
      buttons.length = 0;
      const h = harness();
      h.setStatus(status);
      open(h);
      expect(buttons.find((b) => b.text === "Pair again…")?.cta).toBe(true);
      expect(buttons.map((b) => b.text)).not.toContain("Try again");
    }
  });

  /**
   * **Pair again erases the key, so it is offered only where it can help.** Until
   * 2026-09-26 any refusal carried it — a wire-version mismatch included, where a new
   * registration fixes nothing and the old key was fine. Such a refusal is still a warning,
   * and is offered a retry that keeps everything.
   */
  it("offers no Pair again for any other refusal, and a non-destructive Try again instead", () => {
    const h = harness();
    h.setStatus(mismatched);
    open(h);

    expect(row("Sync")?.descEl.classes.has("mod-warning")).toBe(true);
    expect(buttons.map((b) => b.text)).not.toContain("Pair again…");
    expect(buttons.find((b) => /pair/i.test(b.text))).toBeUndefined();
    const retry = buttons.find((b) => b.text === "Try again");
    expect(retry?.destructive).toBe(false);
    retry?.click();
    expect(h.retrySyncing).toHaveBeenCalledTimes(1);
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(h.startPairing).not.toHaveBeenCalled();
  });

  it("asks first, as Disconnect does, then disconnects locally and starts pairing", async () => {
    const h = harness();
    h.setStatus(refused);
    const tab = open(h);
    const asked: ConfirmCopy[] = [];
    tab.confirm = (copy) => {
      asked.push(copy);
      return Promise.resolve(true);
    };

    buttons.find((b) => b.text === "Pair again…")?.click();
    await vi.waitFor(() => expect(h.startPairing).toHaveBeenCalledWith("My Vault"));

    expect(asked.map((c) => c.title)).toEqual(["Pair this device again?"]);
    expect(asked[0]?.destructive).toBe(true);
    const body = asked[0]?.body.join(" ") ?? "";
    expect(body).toMatch(/erases this device's key/);
    expect(body).toMatch(/stays in your device list until you remove it there/);
    expect(body).toContain("https://app.test");
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      h.startPairing.mock.invocationCallOrder[0] ?? 0,
    );
  });

  /** The real modal, through the default seam: dismissing it is a no, and a no erases
   * nothing. */
  it("erases nothing when the confirmation is dismissed", async () => {
    const h = harness();
    h.setStatus(refused);
    open(h);

    buttons.find((b) => b.text === "Pair again…")?.click();
    const modal = openModals[0];
    expect(modal?.titleEl.texts).toEqual(["Pair this device again?"]);
    expect(buttons.find((b) => b.text === "Pair again")?.destructive).toBe(true);
    modal?.close();
    await landed();

    expect(h.disconnect).not.toHaveBeenCalled();
    expect(h.startPairing).not.toHaveBeenCalled();
  });

  it("appears when a refusal arrives while the pane is open, and goes when it clears", () => {
    const h = harness();
    open(h);
    expect(buttons.map((b) => b.text)).not.toContain("Pair again…");

    h.setStatus(refused);
    expect(buttons.map((b) => b.text)).toContain("Pair again…");

    // A different refusal swaps the button rather than keeping the old one.
    buttons.length = 0;
    h.setStatus(mismatched);
    expect(buttons.map((b) => b.text)).toContain("Try again");
    expect(buttons.map((b) => b.text)).not.toContain("Pair again…");

    buttons.length = 0;
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3 });
    expect(buttons.map((b) => b.text)).not.toContain("Pair again…");
    expect(buttons.map((b) => b.text)).not.toContain("Try again");
    expect(row("Sync")?.descEl.classes.has("mod-warning")).toBe(false);
  });
});

describe("who and where", () => {
  it("names the vault from the overview once it has loaded", async () => {
    open(harness());
    await landed();
    expect(settingRows.filter((r) => r.name === "Vault").slice(-1)[0]?.desc).toBe("Work");
  });

  it("falls back to a short vault id when the vault has no name", async () => {
    open(harness({}, () => Promise.resolve(loaded([], null))));
    await landed();
    const vault = settingRows.filter((r) => r.name === "Vault").slice(-1)[0];
    expect(vault?.desc).toBe("Vault ID e000 518f…");
  });

  it("links to the device list", () => {
    const h = harness();
    open(h);
    buttons.find((b) => b.text === "Manage devices")?.click();
    expect(h.opened).toEqual(["https://app.test/app/devices"]);
  });
});

describe("the agents that can reach this vault", () => {
  const agents = [
    {
      name: "Claude Code",
      capability: "rw",
      issued_at: 0,
      last_used_at: NOW - 60_000,
      expires_at: 0,
    },
    { name: null, capability: "r", issued_at: 0, last_used_at: NOW - 3 * DAY, expires_at: 0 },
    { name: "Old", capability: "r", issued_at: 0, last_used_at: null, expires_at: 0 },
  ];

  it("lists each agent with its access and when it was last used", async () => {
    open(harness({}, () => Promise.resolve(loaded(agents))));
    await landed();

    expect(names()).toContain("Agents");
    expect(row("Claude Code")?.desc).toBe("Read and write · Last used today");
    expect(row("Unnamed agent")?.desc).toBe("Read only · Last used 3 days ago");
    expect(row("Old")?.desc).toBe("Read only · Never used");
  });

  it("says so when there are none, and how to connect Claude Code", async () => {
    open(harness());
    await landed();

    const empty = row("No agents are connected to this vault yet.");
    expect(empty).toBeDefined();
    expect(empty?.descEl.code).toEqual([CONNECT_CLAUDE_CODE]);
    // Word for word the web app's Claude Code guide (`apps/client/src/lib/guides.ts`).
    expect(CONNECT_CLAUDE_CODE).toBe(
      "claude mcp add --transport http --scope user ctrlnotes https://mcp.ctrlnotes.app/mcp",
    );
  });

  it("links to the agents page", () => {
    const h = harness();
    open(h);
    buttons.find((b) => b.text === "Manage agents")?.click();
    expect(h.opened).toEqual(["https://app.test/app/agents"]);
  });

  /** A control plane older than the route. No heading, no error: nothing to show. */
  it("hides the whole section on a 404", async () => {
    await settled(open(harness({}, () => Promise.resolve({ status: "absent" }))));

    expect(names()).not.toContain("Agents");
    expect(names()).not.toContain("Connect or remove agents");
    expect(settingsText()).not.toMatch(/load agents|no agents/i);
    expect(buttons.map((b) => b.text)).not.toContain("Manage agents");
    // The rest of the pane is intact.
    expect(names()).toContain("Disconnect this device");
  });

  it("says one muted line on any other failure, and keeps the pane", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    open(harness({}, () => Promise.resolve({ status: "failed", reason: "http_401" })));
    await landed();

    expect(settingsText()).toContain("Couldn't load agents.");
    expect(settingsText()).not.toContain("http_401");
    expect(warn).toHaveBeenCalled();
    expect(names()).toContain("Disconnect this device");
  });

  it("loads once when the pane opens, not on every redraw", async () => {
    const h = harness();
    const tab = open(h);
    await landed();
    tab.display();
    tab.display();
    await landed();
    expect(h.overviewCalls()).toBe(1);
  });

  it("loads again when the pane is opened again", async () => {
    const h = harness();
    const tab = open(h);
    await landed();
    tab.hide();
    tab.display();
    await landed();
    expect(h.overviewCalls()).toBe(2);
  });

  it("loads again on Refresh", async () => {
    const h = harness();
    open(h);
    await landed();
    buttons.find((b) => b.text === "Refresh")?.click();
    await landed();
    expect(h.overviewCalls()).toBe(2);
  });

  /** An answer that lands after the pane closed is dropped, so the next open asks again. */
  it("drops an answer that lands after the pane closed", async () => {
    let answer: (r: OverviewResult) => void = () => {};
    const h = harness({}, () => new Promise((resolve) => (answer = resolve)));
    const tab = open(h);
    tab.hide();
    answer(loaded(agents));
    await landed();
    tab.display();
    expect(h.overviewCalls()).toBe(2);
  });

  /**
   * Closing the pane keeps the last answer, so a reopen goes on naming the vault and listing
   * its agents while the fresh answer is on its way — rather than dropping to a vault id and
   * "Loading" and back again, which is what `hide()` used to do by forgetting everything.
   */
  it("keeps showing the last answer while a reopen refreshes it", async () => {
    let calls = 0;
    const h = harness({}, () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(loaded(agents)) : new Promise(() => {});
    });
    const tab = open(h);
    await landed();
    tab.hide();

    settingRows.length = 0;
    tab.display();
    await landed();

    expect(h.overviewCalls()).toBe(2);
    expect(row("Vault")?.desc).toBe("Work");
    expect(names()).toContain("Claude Code");
    expect(settingsText()).not.toContain("Loading agents…");
  });

  it("is not polled", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    open(harness());
    expect(interval).not.toHaveBeenCalled();
  });
});

/**
 * **A list belongs to the pairing it was loaded under.** Disconnect, then a pairing to a
 * different vault, with the pane open throughout: the pane used to go on naming the old
 * vault and listing its agents, and an answer still in flight from before the change could
 * land on top of the new one.
 */
describe("the agents list across a change of pairing", () => {
  const OLD = "e000518f8653638e404ca98c6d0a8f10";
  const NEW = "b1946ac92492d2347c6235b4d2611184";
  const overviewOf = (vault_id: string, name: string, agent: string): OverviewResult => ({
    status: "loaded",
    overview: {
      vault: { vault_id, name },
      agents: [{ name: agent, capability: "r", issued_at: 0, last_used_at: null, expires_at: 0 }],
    },
  });

  it("reloads for the new vault, never shows the old list, and drops an old answer", async () => {
    const answers: Array<(r: OverviewResult) => void> = [];
    const h = harness({}, () => new Promise((resolve) => answers.push(resolve)));
    open(h);
    answers[0]?.(overviewOf(OLD, "Work", "Old agent"));
    await landed();
    expect(names()).toContain("Old agent");

    // A refresh for the old vault, still in flight when the pairing changes under it.
    buttons.find((b) => b.text === "Refresh")?.click();
    expect(answers).toHaveLength(2);

    settingRows.length = 0;
    h.repair("", null); // Disconnect.
    h.repair(NEW, "0cc175b9c0f1b6a831c399e269772661"); // Adopted a different vault.
    expect(answers).toHaveLength(3);
    expect(names()).not.toContain("Old agent");
    expect(settingsText()).toContain("Loading agents…");

    // The old vault's answer lands late. It must not be drawn.
    answers[1]?.(overviewOf(OLD, "Work", "Old agent"));
    await landed();
    expect(names()).not.toContain("Old agent");
    expect(settingRows.filter((r) => r.name === "Vault").map((r) => r.desc)).not.toContain("Work");

    answers[2]?.(overviewOf(NEW, "Personal", "New agent"));
    await landed();
    expect(names()).toContain("New agent");
    expect(settingRows.filter((r) => r.name === "Vault").slice(-1)[0]?.desc).toBe("Personal");
    expect(names()).not.toContain("Old agent");
  });

  /** The guard where the overview is read: an answer naming another vault is not drawn. */
  it("draws no overview that names a vault other than this device's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    open(harness({}, () => Promise.resolve(overviewOf(NEW, "Personal", "Stranger"))));
    await landed();

    expect(names()).not.toContain("Stranger");
    expect(settingRows.filter((r) => r.name === "Vault").slice(-1)[0]?.desc).toBe(
      "Vault ID e000 518f…",
    );
    expect(settingsText()).toContain("Couldn't load agents.");
    expect(warn).toHaveBeenCalled();
  });
});
