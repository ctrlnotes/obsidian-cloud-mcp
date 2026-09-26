import {
  type App,
  Notice,
  type Plugin,
  PluginSettingTab,
  type Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from "obsidian";
import { askToConfirm, type ConfirmCopy, showSkippedFiles } from "./modals.ts";
import { capabilityText, lastUsedText, type Overview, type OverviewResult } from "./overview.ts";
import { PRODUCT_NAME } from "./product.ts";
import { shortId } from "./short-id.ts";
import {
  type SkippedFile,
  type StatusReport,
  type SyncStatus,
  statusReport,
} from "./sync/status.ts";

export { PRODUCT_NAME };

/**
 * Everything the tab needs of "the plugin" — a narrow interface it owns, the same shape
 * `device.ts`'s `SecretStorageHost` and `state.ts`'s `LocalStore` already use, rather than
 * the whole `CtrlNotesPlugin` class (`main.ts`).
 *
 * **Two origins and no vault id.** An earlier revision of this comment said there was "no
 * web app origin to remember — the approval screen does not exist yet", and declared a
 * `setVaultId` beside it. Design §5 inverts both: the browser is where a pairing is
 * confirmed, so the web app's origin is something this plugin must be told (§7 — it may be
 * a different host from the control plane, and is definitely a different one from the
 * control plane's non-Worker name); and the VAULT is chosen there, from the vaults that
 * session owns (D9/D11), then adopted here after a human confirms it (D19). A text box for
 * a vault id could only ever be wrong — `SyncSocket` signs every challenge for whatever it
 * holds (rule 3), so a typo is an opaque "not authorised" nothing on the wire can correct.
 */
export interface SettingsHost {
  /**
   * The control plane's **direct** hostname — the one that does not sit behind the
   * Cloudflare Worker (design §7). The plugin's calls are made by the plugin, not by a
   * browser, so they have no reason to take the web front end's path and every reason not
   * to: the sync socket's URL is derived from this same value.
   */
  readonly controlplaneOrigin: string;
  /** Where the system browser is sent to confirm a pairing — `<webAppOrigin>/app/pair?i=…`
   * — and where a user's device list lives. */
  readonly webAppOrigin: string;
  /** `""` until a pairing has been adopted. Adopted, never typed (D11). */
  readonly vaultId: string;
  /** `null` until a redemption has succeeded. */
  readonly deviceId: string | null;
  /**
   * This device has registered an intent and is waiting on a browser.
   *
   * A boolean and nothing more, deliberately. Its predecessor handed the tab the pairing
   * itself so the pane could render "Code: …", and there is no code (rule 5) — there is no
   * value in a pairing that this pane may show, because anything it could show would be a
   * value in a claimable channel.
   */
  readonly pairingInFlight: boolean;
  /** A name for this device's own pairing label. */
  readonly vaultName: string;

  setControlplaneOrigin(value: string): Promise<void>;
  setWebAppOrigin(value: string): Promise<void>;
  /** Registers a pairing intent, opens the system browser, and returns once the whole flow
   * settles — including the confirmation this device asks for at the end (D19). Errors are
   * reported by the host, not thrown — the same posture every other Obsidian-facing surface
   * in this plugin takes. */
  startPairing(label: string): Promise<void>;
  /**
   * **Local only, and its copy has to say so** (design §6.3). Forgets this device's
   * registration and destroys its private key. It is NOT a revocation: neither revoke path
   * is reachable from the plugin — hop 2 needs a browser-minted grant and the vault's own
   * `DELETE /v1/devices/{id}` needs the operator static token — so the vault row stays
   * trusted until somebody removes it from the device list in the web app.
   */
  disconnect(): Promise<void>;

  syncStatus(): SyncStatus;
  onStatusChange(listener: (status: SyncStatus) => void): () => void;
  /** Fires when this device starts, finishes or abandons a pairing. */
  onPairingChange(listener: () => void): () => void;

  /** The files behind the status's three counts, each with its reason. */
  skippedFiles(): readonly SkippedFile[];
  /**
   * `GET /v1/sync/overview`, signed with the same routing proof as the sync socket. Never
   * rejects: every failure is a value, because this section must never break the pane.
   */
  loadOverview(): Promise<OverviewResult>;
  /** The plugin's one wall clock (`main.ts`'s `now` seam), for "last used 3 days ago". */
  now(): number;
  /** Open a web app page in the system browser — the same call pairing uses. */
  openInBrowser(url: string): void;
  /**
   * Send the browser back to the pair page for the intent this device is waiting on.
   * `false` when there is no persisted intent to rebuild the link from.
   */
  reopenPairingPage(): boolean;
  /** Stop waiting: forget the local intent and stop polling for it. Nothing is sent. */
  cancelPairing(): void;
  /**
   * Connect again after a refusal ended syncing — the pane's "Try again", and the same call
   * "Sync now" makes in that state. **Non-destructive**: the registration and its key are
   * kept, so a refusal that was about the moment (a vault mid-upgrade answering with a wire
   * version this plugin does not speak yet) clears by itself when the vault next accepts.
   * Does nothing unless this device is paired and holds no connection.
   */
  retrySyncing(): void;
}

/**
 * The shipped deployment's two hostnames — **`main.ts`'s `DEFAULT_SETTINGS` reads them from
 * here**, so the placeholder a user sees and the value actually stored cannot drift apart.
 * That drift is the whole reason they are not two pairs of string literals in two files:
 * a placeholder naming one host beside a stored default naming another is a bug nobody
 * would think to look for.
 *
 * `sync.ctrlnotes.app` is the control plane on a name that does NOT go through the
 * Cloudflare Worker (`docs/deployment-topology.md`, design §7); `ctrlnotes.app` is where a
 * browser signs in and where `/app/pair` lives.
 */
export const DEFAULT_CONTROLPLANE_ORIGIN = "https://sync.ctrlnotes.app";
export const DEFAULT_WEB_APP_ORIGIN = "https://ctrlnotes.app";

/**
 * **Declarative, on Obsidian 1.13's settings API** (`getSettingDefinitions`), so the pane's
 * rows appear in Obsidian's settings search. It was an imperative `display()` until
 * `minAppVersion` reached 1.13; `display()` is deprecated there, and the directory's review
 * lint flags a tab that still overrides it.
 *
 * The pane has three faces — unpaired, waiting for the browser, connected — and each row
 * says which it belongs to with `visible`. A pairing starting, finishing or being
 * abandoned calls `update()`, which re-reads the definitions and redraws an open pane.
 *
 * **Status and the primary action first; the two addresses last, under Advanced.** Nearly
 * nobody changes either — the shipped defaults are the deployment — and a pane that opened
 * on two text boxes of hostnames read as a form to fill in before anything would work.
 */
export class CtrlNotesSettingsTab extends PluginSettingTab {
  /**
   * The agents list, and the vault name that arrives with it. `idle` means nothing is known
   * for the vault this device is paired with now.
   *
   * **Kept across closing the pane**, so a reopen goes on showing the last answer — the
   * vault's name included — until the fresh one lands, rather than flashing back to "Loading"
   * and a vault id. What it is NOT kept across is a pairing change (`forgetAgents`): a list
   * loaded for one vault must never be drawn under another.
   */
  private agents: AgentsState = { status: "idle" };
  /** A load has been started since the pane last opened, which is what `ensureAgents` asks. */
  private asked = false;
  /**
   * Bumped whenever the pane closes, a refresh starts or the pairing changes, so an answer
   * that lands after any of them is dropped rather than written over a newer state.
   * `requestUrl` has no abort.
   */
  private generation = 0;

  /**
   * The confirmation before Disconnect, as a seam: the real modal by default, the same
   * shape `main.ts`'s `confirmAdoption` has.
   */
  confirm: (copy: ConfirmCopy) => Promise<boolean> = (copy) => askToConfirm(this.app, copy);

  constructor(
    app: App,
    private readonly host: Plugin & SettingsHost,
  ) {
    super(app, host);
    // **Subscribed once, for the life of the plugin, not per render.** A pairing can start
    // or finish while the pane shows any of its three faces — a cold-launch resume and an
    // `obsidian://` nudge both begin one with nobody having pressed anything — so the rows
    // must be re-derived whichever face is showing. The plugin owns the unsubscribe.
    //
    // **The agents list is forgotten here too.** It belongs to the pairing it was loaded
    // under: after Disconnect and a pairing to a different vault, the pane would otherwise go
    // on naming the old vault and listing the old vault's agents — and an answer still in
    // flight from before the change would land on top of the new one.
    host.register(
      host.onPairingChange(() => {
        this.forgetAgents();
        this.update();
      }),
    );
  }

  /**
   * Closing the pane means the next open asks again. **Loaded when the pane opens and on
   * Refresh, never on a timer**: which agents can reach a vault changes when somebody changes
   * it in the web app, and polling for that from every open Obsidian would cost the control
   * plane a request a minute per device for a list nobody is looking at.
   *
   * The last answer is kept (see `agents`); only a load still in flight is abandoned, and it
   * is the one state that cannot be kept, because its answer will now be dropped.
   */
  override hide(): void {
    super.hide();
    this.generation += 1;
    this.asked = false;
    if (this.agents.status === "loading") this.agents = { status: "idle" };
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const connected = (): boolean => this.host.deviceId !== null;
    const waiting = (): boolean => !connected() && this.host.pairingInFlight;
    const unpaired = (): boolean => !connected() && !this.host.pairingInFlight;
    return [
      {
        name: "Pair this device",
        desc:
          "Opens your browser, where you choose which vault this device joins. Nothing is " +
          "connected until you confirm it here in Obsidian as well.",
        visible: unpaired,
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText("Pair")
              .setCta()
              // **Both origins, and NOT a vault id.** The old condition asked for a vault id
              // this flow cannot have yet, which disabled the button forever; the web app's
              // origin is what `startPairing` genuinely refuses without.
              .setDisabled(this.host.controlplaneOrigin === "" || this.host.webAppOrigin === "")
              .onClick(() => {
                void this.host.startPairing(this.host.vaultName);
                this.update();
              }),
          );
        },
      },
      // **Carries no value from the pairing, and that is the point** (rule 1, rule 5). Its
      // predecessor rendered "Code: abc123" here. Everything this pane knows is that a
      // browser is expected to do something: the intent id it waits on is spendable only by
      // proving possession of the device key (D14). "Open browser again" rebuilds the link
      // from that id without showing it.
      {
        name: "Waiting for your browser",
        desc:
          `Finish connecting this device at ${this.webApp()}, then come back here to ` +
          "confirm it. Obsidian can be closed in the meantime; this device picks the " +
          "request back up when it next starts.",
        visible: waiting,
        render: (setting) => {
          setting
            .addButton((button) =>
              button.setButtonText("Open browser again").onClick(() => {
                if (!this.host.reopenPairingPage()) {
                  new Notice(
                    "This device is no longer waiting for a browser. Pair it again to continue.",
                  );
                }
              }),
            )
            .addButton((button) =>
              button.setButtonText("Cancel pairing").onClick(() => {
                this.host.cancelPairing();
              }),
            );
        },
      },
      {
        name: "Sync",
        visible: connected,
        // The status changes while the pane is open, so the row subscribes when it is drawn
        // and returns the unsubscribe — Obsidian runs it before tearing the row down, which
        // is what stops a reused tab accumulating one listener per visit.
        //
        // **Redrawn in place, unless its buttons would change.** "Pair again" and "Try
        // again" belong to a refused session and "Show files" to a non-zero count, and a row
        // cannot grow a button after it is drawn — so a status that crosses any of those
        // lines re-reads the definitions instead. Everything else only rewrites the words.
        //
        // **Only the revoked-elsewhere refusal is offered "Pair again"** (`repairable`),
        // because pairing again erases this device's key. Every other refusal — a wire
        // version this plugin does not speak, a sentence it has never seen — is not about the
        // registration at all, and is offered a retry that keeps it.
        render: (setting) => {
          const drawn = this.host.syncStatus();
          const report = statusReport(drawn);
          this.drawStatus(setting, report);
          if (hasSkipped(drawn)) {
            setting.addButton((button) =>
              button.setButtonText("Show files").onClick(() => {
                showSkippedFiles(this.app, this.host.skippedFiles());
              }),
            );
          }
          if (report.repairable) {
            setting.addButton((button) =>
              button
                .setButtonText("Pair again…")
                .setCta()
                .onClick(() => {
                  void this.pairAgainAfterConfirming();
                }),
            );
          } else if (report.warning) {
            setting.addButton((button) =>
              button.setButtonText("Try again").onClick(() => {
                this.host.retrySyncing();
              }),
            );
          }
          return this.host.onStatusChange((next) => {
            if (shapeOf(next) !== shapeOf(drawn)) {
              this.update();
              return;
            }
            this.drawStatus(setting, statusReport(next));
          });
        },
      },
      // **Named "Vault" and "This device", never "Connected".** Those rows used to read
      // "Connected: this device is …" directly beneath "Sync was refused", which is two
      // contradictory claims about one device. What the rows know is identity, not state;
      // the state is the Sync row's job.
      {
        name: "Vault",
        visible: connected,
        render: (setting) => {
          // Every open of the pane draws this row, so it is where the agents list (and the
          // vault name with it) is asked for. See `hide`.
          this.ensureAgents();
          const name = this.overview()?.vault.name ?? null;
          if (name !== null && name !== "") {
            setting.setDesc(name);
          } else {
            labelledId(setting, "Vault ID", this.host.vaultId);
          }
        },
      },
      {
        name: "This device",
        visible: connected,
        render: (setting) => {
          labelledId(setting, "Device ID", this.host.deviceId ?? "");
          setting.addButton((button) =>
            button.setButtonText("Manage devices").onClick(() => {
              this.host.openInBrowser(`${this.webAppBase()}/app/devices`);
            }),
          );
        },
      },
      {
        type: "group",
        heading: "Agents",
        // A 404 is a control plane older than the route: there is no list to show, and a
        // section that says "couldn't load" forever would be an error about nothing.
        visible: () => connected() && this.agents.status !== "absent",
        extraButtons: [
          (button) =>
            button
              .setIcon("refresh-cw")
              .setTooltip("Refresh")
              .onClick(() => {
                this.refreshAgents();
              }),
        ],
        items: [
          ...this.agentRows(),
          {
            name: "Connect or remove agents",
            desc: "Agents are managed in the web app, where you sign in.",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Manage agents").onClick(() => {
                  this.host.openInBrowser(`${this.webAppBase()}/app/agents`);
                }),
              );
            },
          },
        ],
      },
      // **The copy IS the deliverable here** (design §6.3). This button makes no request and
      // cannot: hop 2's revoke needs a grant only a signed-in browser can mint, and the
      // vault's own DELETE needs the operator static token. Calling it "Unpair" beside a
      // device list the user cannot see invites them to believe they have cut off a lost
      // laptop, which is the one belief this pane must not create.
      {
        name: "Disconnect this device",
        desc:
          "Removes the connection on this device only, and erases its key from this " +
          "device. To revoke its access, remove it from your device list at " +
          `${this.webApp()}. Revoking there is immediate and cannot be undone.`,
        visible: connected,
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText("Disconnect…")
              .setDestructive()
              .onClick(() => {
                void this.disconnectAfterConfirming();
              }),
          );
        },
      },
      {
        type: "group",
        heading: "Advanced",
        items: [
          {
            name: "Control plane",
            desc:
              "The service this device connects to. Use its direct address " +
              `(${DEFAULT_CONTROLPLANE_ORIGIN}), not the web app's.`,
            control: {
              type: "text",
              key: "controlplaneOrigin",
              placeholder: DEFAULT_CONTROLPLANE_ORIGIN,
            },
          },
          // **A separate origin, not a derivation of the first** (design §7). The web app and
          // the control plane may be different hosts, and on the shipped deployment they are:
          // one is behind Cloudflare's Worker and the other deliberately is not.
          {
            name: "Web app",
            desc: `Where you sign in and manage your devices and agents (${DEFAULT_WEB_APP_ORIGIN}).`,
            control: { type: "text", key: "webAppOrigin", placeholder: DEFAULT_WEB_APP_ORIGIN },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === "controlplaneOrigin") return this.host.controlplaneOrigin;
    if (key === "webAppOrigin") return this.host.webAppOrigin;
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const cleaned = clean(String(value));
    if (key === "controlplaneOrigin") await this.host.setControlplaneOrigin(cleaned);
    if (key === "webAppOrigin") {
      await this.host.setWebAppOrigin(cleaned);
      // Two descriptions name the web app, and Obsidian draws the pane from the
      // definitions the last `update()` cached — so without this they keep the old
      // address, even across reopening the pane. The input row keeps its key, so the
      // host updates it in place rather than rebuilding it under the user's cursor.
      this.update();
    }
  }

  /** The web app by name, or a description of it when the field is still empty — this pane
   * is telling the user where to GO, and "at ." is not an address. */
  private webApp(): string {
    return this.host.webAppOrigin === "" ? `your ${PRODUCT_NAME} web app` : this.host.webAppOrigin;
  }

  /** The web app to link to, falling back to the shipped one: a link to a relative path
   * would open nothing. */
  private webAppBase(): string {
    return this.host.webAppOrigin === "" ? DEFAULT_WEB_APP_ORIGIN : this.host.webAppOrigin;
  }

  /** The headline, then one line per count, and warning styling for a refused session. */
  private drawStatus(setting: Setting, report: StatusReport): void {
    const desc = setting.descEl;
    desc.empty();
    desc.toggleClass("mod-warning", report.warning);
    desc.createDiv({ text: report.headline });
    for (const line of report.lines) desc.createDiv({ text: line });
  }

  /**
   * The last overview, **only if it describes the vault this device is paired with now** —
   * the guard behind `forgetAgents`, checked where the overview is read rather than trusted
   * to have been cleared. A list drawn under the wrong vault's name is the one thing this
   * section must never show, and the vault id is right there in the answer to check.
   */
  private overview(): Overview | null {
    const state = this.agents;
    if (state.status !== "loaded") return null;
    return state.overview.vault.vault_id === this.host.vaultId ? state.overview : null;
  }

  /** The rows under the Agents heading, for whatever the last load said. */
  private agentRows(): SettingGroupItem[] {
    const state = this.agents;
    if (state.status === "failed") {
      return [{ name: "", desc: "Couldn't load agents.", searchable: false }];
    }
    const overview = this.overview();
    if (overview === null) {
      return [{ name: "", desc: "Loading agents…", searchable: false }];
    }
    if (overview.agents.length === 0) {
      return [
        {
          name: "No agents are connected to this vault yet.",
          render: (setting) => {
            setting.descEl.appendText("To connect Claude Code, run ");
            setting.descEl.createEl("code", { text: CONNECT_CLAUDE_CODE });
          },
        },
      ];
    }
    const now = this.host.now();
    return overview.agents.map((agent) => ({
      name: agent.name ?? "Unnamed agent",
      desc: `${capabilityText(agent.capability)} · ${lastUsedText(agent.last_used_at, now)}`,
    }));
  }

  /** Ask for the agents list if nothing has since the pane opened. */
  private ensureAgents(): void {
    if (!this.asked) this.loadAgents();
  }

  /** The pairing changed: nothing known about the old vault's agents applies any more, and
   * an answer still in flight for it is dropped. */
  private forgetAgents(): void {
    this.generation += 1;
    this.asked = false;
    this.agents = { status: "idle" };
  }

  private refreshAgents(): void {
    this.generation += 1;
    this.loadAgents();
    this.update();
  }

  private loadAgents(): void {
    const generation = this.generation;
    this.asked = true;
    // Only the first load shows "Loading": a reopen keeps drawing the list it already has
    // (`hide` keeps it) until the new answer lands, rather than flashing it away and back.
    if (this.agents.status === "idle" || this.agents.status === "failed") {
      this.agents = { status: "loading" };
    }
    void this.host.loadOverview().then((answer) => {
      if (generation !== this.generation) return;
      // An answer about some other vault is not an answer to this question. Nothing this
      // plugin sends names a vault the control plane could confuse, so this is a bug
      // somewhere — reported as the failure it is rather than drawn, or left "Loading".
      const result: OverviewResult =
        answer.status === "loaded" && answer.overview.vault.vault_id !== this.host.vaultId
          ? { status: "failed", reason: "overview_for_another_vault" }
          : answer;
      if (result.status === "failed") {
        console.warn(`Ctrl Notes: could not load this vault's agents: ${result.reason}`);
      }
      this.agents = result;
      this.update();
    });
  }

  /**
   * "Pair again…", beside the revoked-elsewhere refusal: forget this registration locally,
   * then start a pairing. The first half is exactly Disconnect, **so it asks exactly as
   * Disconnect does**. It used to skip the question on the grounds that the vault had
   * already refused this device — but "not authorised" is also what a device pointed at the
   * wrong vault is told (`status.ts`'s `REVOKED_ELSEWHERE_REASON`), and erasing a key that
   * still works elsewhere is not something one click should do unasked.
   *
   * **No `update()` after either call.** `disconnect()` and `startPairing` both announce
   * themselves through `onPairingChange`, which redraws the pane; `main.test.ts` holds that.
   */
  private async pairAgainAfterConfirming(): Promise<void> {
    const yes = await this.confirm({
      title: "Pair this device again?",
      body: [
        "Pairing again erases this device's key from this device and starts a new pairing " +
          "in your browser. Your notes stay here.",
        "The old registration stays in your device list until you remove it there, at " +
          `${this.webApp()}.`,
      ],
      confirmText: "Pair again",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!yes) return;
    await this.host.disconnect();
    await this.host.startPairing(this.host.vaultName);
  }

  private async disconnectAfterConfirming(): Promise<void> {
    const yes = await this.confirm({
      title: "Disconnect this device?",
      body: [
        "This removes the connection on this device only, and erases its key from this " +
          "device. Your notes stay here.",
        "It does not revoke the device. To do that, remove it from your device list at " +
          `${this.webApp()}.`,
      ],
      confirmText: "Disconnect",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!yes) return;
    // The pane redraws from `disconnect()`'s own pairing notification, as for Pair again.
    await this.host.disconnect();
    new Notice(`This device is disconnected from ${PRODUCT_NAME}.`);
  }
}

type AgentsState = { readonly status: "idle" } | { readonly status: "loading" } | OverviewResult;

/**
 * The command the empty Agents list suggests. The server name matches the MCP's own, and
 * the whole command matches the web app's Claude Code guide word for word — `--scope user`
 * included, so the server is there in every project rather than only the one the user
 * happened to run it in, and a user who has seen both is not left wondering which is right.
 */
export const CONNECT_CLAUDE_CODE =
  "claude mcp add --transport http --scope user ctrlnotes https://mcp.ctrlnotes.app/mcp";

const hasSkipped = (status: SyncStatus): boolean =>
  status.unsyncable + status.refused + status.unavailable > 0;

/** Which buttons the Sync row carries for a status. A change here needs a new row. */
const shapeOf = (status: SyncStatus): string => {
  const report = statusReport(status);
  return `${report.warning}/${report.repairable}/${hasSkipped(status)}`;
};

/** `Vault ID e000 518f…`, the id in monospace. */
function labelledId(setting: Setting, label: string, id: string): void {
  setting.descEl.empty();
  setting.descEl.appendText(`${label} `);
  setting.descEl.createEl("code", { text: shortId(id) });
}

/** Trimmed, with any trailing slash off: both fields are joined to a path, and
 * `https://x//v1/…` is not the same URL. */
const clean = (value: string): string => value.trim().replace(/\/+$/, "");
