import type { App, Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    onPairingChange: () => () => {},
    register: () => {},
    ...settingsHostDefaults(),
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

  it("offers Pair again, which disconnects locally and then starts pairing", async () => {
    const h = harness();
    h.setStatus(refused);
    open(h);

    const pairAgain = buttons.find((b) => b.text === "Pair again");
    expect(pairAgain?.cta).toBe(true);
    pairAgain?.click();
    await vi.waitFor(() => expect(h.startPairing).toHaveBeenCalledWith("My Vault"));
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      h.startPairing.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("appears when a refusal arrives while the pane is open, and goes when it clears", () => {
    const h = harness();
    open(h);
    expect(buttons.map((b) => b.text)).not.toContain("Pair again");

    h.setStatus(refused);
    expect(buttons.map((b) => b.text)).toContain("Pair again");

    buttons.length = 0;
    h.setStatus({ ...IDLE_STATUS, syncedCursor: 3 });
    expect(buttons.map((b) => b.text)).not.toContain("Pair again");
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
    expect(CONNECT_CLAUDE_CODE).toBe(
      "claude mcp add --transport http ctrlnotes https://mcp.ctrlnotes.app/mcp",
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

  it("is not polled", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    open(harness());
    expect(interval).not.toHaveBeenCalled();
  });
});
