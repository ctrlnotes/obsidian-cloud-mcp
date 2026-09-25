import {
  type App,
  Notice,
  type Plugin,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import { describeStatus, type SyncStatus } from "./sync/status.ts";

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
 * The product's name, for UI text that names it. **Interpolated, not written into the
 * literal**: `obsidianmd/ui/sentence-case` does not know it is a brand and wants "ctrl
 * notes" in a plain string, which is why four notices said "ctrlrouter" until 2026-09-24.
 * The rule checks only a plain string or a template with no expressions, so a message
 * that interpolates this is not case-checked at all — the brand is not exempted, the
 * whole string is. We assume the directory's scan runs with its own configuration rather
 * than this repository's, so a `brands` option here would not reach it (unverified).
 */
export const PRODUCT_NAME = "Ctrl Notes";

/**
 * **Declarative, on Obsidian 1.13's settings API** (`getSettingDefinitions`), so the pane's
 * rows appear in Obsidian's settings search. It was an imperative `display()` until
 * `minAppVersion` reached 1.13; `display()` is deprecated there, and the directory's review
 * lint flags a tab that still overrides it.
 *
 * The pane has three faces — unpaired, waiting for the browser, connected — and each row
 * says which it belongs to with `visible`. A pairing starting, finishing or being
 * abandoned calls `update()`, which re-reads the definitions and redraws an open pane.
 */
export class CtrlNotesSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: Plugin & SettingsHost,
  ) {
    super(app, host);
    // **Subscribed once, for the life of the plugin, not per render.** A pairing can start
    // or finish while the pane shows any of its three faces — a cold-launch resume and an
    // `obsidian://` nudge both begin one with nobody having pressed anything — so the rows
    // must be re-derived whichever face is showing. The plugin owns the unsubscribe.
    host.register(host.onPairingChange(() => this.update()));
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const connected = (): boolean => this.host.deviceId !== null;
    const waiting = (): boolean => !connected() && this.host.pairingInFlight;
    const unpaired = (): boolean => !connected() && !this.host.pairingInFlight;
    return [
      {
        name: "Control plane",
        desc:
          "Where this device registers a pairing and looks up its result. Use the direct " +
          `hostname (${DEFAULT_CONTROLPLANE_ORIGIN}), not the web app's: this plugin is not a ` +
          "browser, and the sync connection is made to this address too.",
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
        desc:
          "Where your browser confirms this device and lists the devices on your vaults " +
          `(${DEFAULT_WEB_APP_ORIGIN}). This is the site you sign in to.`,
        control: { type: "text", key: "webAppOrigin", placeholder: DEFAULT_WEB_APP_ORIGIN },
      },
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
      // proving possession of the device key (D14).
      {
        name: "Waiting for your browser",
        desc:
          `Finish connecting this device at ${this.webApp()}, then come back here to ` +
          "confirm it. Obsidian can be closed in the meantime; this device picks the " +
          "request back up when it next starts.",
        visible: waiting,
      },
      {
        name: "Sync",
        visible: connected,
        // The status changes while the pane is open, so the row subscribes when it is drawn
        // and returns the unsubscribe — Obsidian runs it before tearing the row down, which
        // is what stops a reused tab accumulating one listener per visit.
        render: (setting) => {
          setting.setDesc(describeStatus(this.host.syncStatus()));
          return this.host.onStatusChange((next) => {
            setting.setDesc(describeStatus(next));
          });
        },
      },
      {
        name: "Connected",
        desc: `This device is ${this.host.deviceId}, syncing with vault ${this.host.vaultId}.`,
        visible: connected,
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
          "computer. To revoke its access, remove it from your device list at " +
          `${this.webApp()}. Revoking there is immediate and cannot be undone.`,
        visible: connected,
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Disconnect this device").onClick(() => {
              void this.host.disconnect().then(() => {
                new Notice(`This device is disconnected from ${PRODUCT_NAME}`);
                this.update();
              });
            }),
          );
        },
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
    return this.host.webAppOrigin === "" ? "your Ctrl Notes web app" : this.host.webAppOrigin;
  }
}

/** Trimmed, with any trailing slash off: both fields are joined to a path, and
 * `https://x//v1/…` is not the same URL. */
const clean = (value: string): string => value.trim().replace(/\/+$/, "");
