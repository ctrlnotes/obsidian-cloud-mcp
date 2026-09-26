// The plugin shell (write-surface design §5, plugin design §5): wires every module built in
// Tasks 1-12 into the sync loop the spec draws:
//
//   Obsidian events ──▶ settle ──▶ derive ──▶ the outbound queue (Pump/SyncSocket)
//   socket events ──▶ Pump.handleDown ──▶ apply ────────────────────────────────▶ ack
//
// **This is a rewrite, not an adaptation of the ported file.** an earlier prototype's `main.ts` (1,601
// lines) wires a completely different shape: device-code + `obsidian://` redirect pairing,
// a hint-only socket plus a batched HTTP exchange, and a bidirectional manifest compare
// with its own `push`/`pull`/`differ` lists. None of that exists on this protocol — pairing
// is an intent registered by the plugin and confirmed in a signed-in browser
// (`pairing-intent.ts` + `adopt.ts`, design §5), where the redirect carries nothing at all
// (D15), and `SyncSocket`/`Pump` already own the whole duplex transport and its outbound
// queue. What
// is carried across deliberately, because it is the part hardest to rediscover, is
// An earlier prototype's LIFECYCLE care: a pairing poll or redemption can resolve after `onunload` —
// `requestUrl` has no abort, so a response already on the wire still lands — and every
// place that response reaches plugin state checks `this.active` first, exactly as
// An earlier prototype's `finishPairing` did.
//
// **Rule 2 lives one layer down, in `sync/apply.ts`** (`applyReplay` never deletes what it
// was not told to; `applySnapshot` is the only entry point allowed to). This file's job is
// only to call the right one for the `Down` frame that arrived, which `sync/pump.ts`
// already does — nothing here re-implements that decision.
//
// **A known, reported gap: `fetchBytes` below has nothing to call.** Write-surface design
// §8.1 sketches a `want`/fetch exchange for inbound content, but
// `apps/vault/src/sync/wire.rs` defines no such frame and
// `apps/vault/src/http/routes/sync.rs`'s `run()` loop never sends binary content downward
// — only accepts it upward via `Upload`. This was already flagged by the phase that built
// `apply.ts` and `pump.ts` (their own doc comments say `fetchBytes` is "purely caller-
// injected" and "not this module's concern") and remains unresolved here: it is a vault-
// side wire gap, not something a plugin-only task can close. Every inbound event or
// snapshot entry that needs content is logged and skipped rather than guessed at.

import type { App, PluginManifest, TAbstractFile } from "obsidian";
import { Notice, Platform, Plugin, setIcon } from "obsidian";
import {
  type AdoptionOffer,
  askToAdopt,
  type ConfirmAdoption,
  offerAdoption,
  redeemPairing,
} from "./adopt.ts";
import { type Requested, request } from "./controlplane-http.ts";
import { DeviceIdentity, forgetDeviceKey, publicKeyStandardBase64 } from "./device.ts";
import { fetchOverview, type OverviewResult } from "./overview.ts";
import {
  type BoundPairing,
  clearPairingState,
  loadPairingState,
  openInSystemBrowser,
  type PairingState,
  pairPageUrl,
  startPairing as registerPairingIntent,
  retrieveOnce,
  retrieveWhenBound,
} from "./pairing-intent.ts";
import { handleProtocol, PAIRED_ACTIONS } from "./protocol.ts";
import { asSentence, failureMessage } from "./reasons.ts";
import {
  CtrlNotesSettingsTab,
  DEFAULT_CONTROLPLANE_ORIGIN,
  DEFAULT_WEB_APP_ORIGIN,
  PRODUCT_NAME,
  type SettingsHost,
} from "./settings-tab.ts";
import { type Applied, pullIfUnchanged, type VaultFiles } from "./sync/apply.ts";
import { batchLimitsFrom } from "./sync/batch.ts";
import { type Change, deriveChanges, type ReadableFiles, syncablePath } from "./sync/derive.ts";
import { Fetcher } from "./sync/fetcher.ts";
import { type ScannableVault, scanManifest } from "./sync/manifest-scan.ts";
import {
  decideIdleWake,
  decideSignalWake,
  FRESH_SIGNAL_MEMORY,
  hasSomethingToSend,
  readSignal,
  SIGNAL_POLL_MS,
  SIGNAL_TIMEOUT_MS,
  type SignalMemory,
  WAKE_JITTER_MS,
} from "./sync/park.ts";
import { Pump, type PumpDeps, type SyncTransport } from "./sync/pump.ts";
import type { ResultOutcome } from "./sync/results.ts";
import { planRetry } from "./sync/retry.ts";
import { Settler } from "./sync/settle.ts";
import { type SocketLike, SyncSocket } from "./sync/socket.ts";
import { adoptUnstampedState, loadSyncState, type SyncState, saveSyncState } from "./sync/state.ts";
import { IDLE_STATUS, type SkippedFile, type SyncStatus, statusBarFace } from "./sync/status.ts";
import { foldListing, indexOddSpellings, toWirePath } from "./sync/wire-path.ts";
import type { Down, DownRefused } from "./wire.ts";

interface Settings {
  readonly controlplaneOrigin: string;
  /**
   * Where the system browser is sent to confirm a pairing — `<webAppOrigin>/app/pair?i=…`
   * (design §5.4).
   *
   * **A second, separate origin, not a derivation of the first.** The web app and the
   * control plane may be different hosts (§7), and `startPairing` refuses up front rather
   * than registering a live intent it would then send the browser to a relative URL for.
   *
   * `startPairing` refuses with `origin_not_configured` while it is `""`, which is what a
   * user who has cleared the field sees rather than a browser opened at a relative URL.
   */
  readonly webAppOrigin: string;
  /**
   * The vault this device syncs with.
   *
   * **Adopted, not configured** (D11, D19). It arrives from the D14 retrieval and is written
   * exactly once, after a human on this device confirms it — `adopt.ts` holds the reasoning
   * and the guard. There is no setter and no settings row: the browser chooses the vault
   * from the ones its own session owns, and a value typed here is what `SyncSocket` would
   * sign every challenge for (rule 3), so a typo could only present as an opaque refusal.
   */
  readonly vaultId: string;
  /** `null` until a redemption has succeeded. Never a secret — knowing it authorises
   * nothing without the private key `device.ts` alone holds — so it is fine beside the
   * other two in ordinary, vault-replicated `saveData` (rule 1 is about the KEY only). */
  readonly deviceId: string | null;
}

/**
 * **The shipped hostnames, not `""`** (design §7, which asks for this by name).
 *
 * `sync.ctrlnotes.app` is the control plane on a name that does NOT go through the
 * Cloudflare Worker (`docs/deployment-topology.md`) — the plugin is not a browser, and this
 * same value is what `toWsUrl` turns into the sync socket's address, so it could not have
 * been the web app's name even if a user wanted it to be. `ctrlnotes.app` is where a
 * browser signs in and where `/app/pair` lives.
 *
 * Both stay editable: a self-hosted deployment is two fields away, and a blank pair here
 * would make the shipped one two fields away instead, for no gain.
 *
 * The two strings live in `settings-tab.ts` because that file also renders them as
 * placeholders, and a placeholder naming a different host from the stored default is a bug
 * nobody would think to look for.
 */
const DEFAULT_SETTINGS: Settings = {
  controlplaneOrigin: DEFAULT_CONTROLPLANE_ORIGIN,
  webAppOrigin: DEFAULT_WEB_APP_ORIGIN,
  vaultId: "",
  deviceId: null,
};

/** The two members of Obsidian's settings modal `openOwnSettings` calls. Not public API. */
interface SettingsModal {
  open(): void;
  openTabById(id: string): unknown;
}

interface Touched {
  readonly dirty: Set<string>;
  readonly deleted: Set<string>;
  readonly renamed: Map<string, string>;
}

const emptyTouched = (): Touched => ({ dirty: new Set(), deleted: new Set(), renamed: new Map() });

/** `https://` → `wss://`, `http://` → `ws://`. The control plane's own origin, never a
 * vault address directly — a vault has no public address by design. */
const toWsUrl = (origin: string): string => origin.replace(/^http/, "ws");

/**
 * **Iterate a copy, never the live `Set` — this one hangs Obsidian** (blocker fix).
 *
 * A JS `Set` iterator visits values ADDED during its own iteration, and every listener here
 * belongs to `CtrlNotesSettingsTab`, which when this was written reacted with `display()` —
 * dropping its subscription and immediately taking a fresh one. So notifying a live set
 * meant: visit the tab's listener, the tab re-subscribes, the iterator reaches the listener
 * it just added, notify it again, forever, on the UI thread, with no error and no way out
 * but killing the app. Verified in Node: the loop does not terminate. The tab is
 * declarative now (it subscribes once and calls `update()`), but a listener that
 * re-subscribes is an easy thing to write again, so the copy stays.
 *
 * The hazard predates this function — `renderPending` had the same re-subscribe — but was
 * unreachable, because the property that branch keyed off was hardcoded `null`. Widening
 * the tab's subscription to every face of the pane is what would have armed it.
 */
const snapshot = <T>(listeners: ReadonlySet<T>): T[] => [...listeners];

/** Backoff for a pull that failed transiently: 2 s, doubling, capped at 5 min. */
const PULL_RETRY_BASE_MS = 2_000;
const PULL_RETRY_MAX_MS = 300_000;

/** "Sync now" on a device that already has a connection, or is making one. */
const ALREADY_SYNCING = `${PRODUCT_NAME} is already syncing.`;

export default class CtrlNotesPlugin extends Plugin implements SettingsHost {
  private cfg: Settings = DEFAULT_SETTINGS;
  private identity: DeviceIdentity | null = null;
  private syncState: SyncState = { cursor: 0, hashes: {} };

  /**
   * `onunload`, not a registration made during load. `onload` awaits the device identity
   * before it registers anything, so a user disabling the plugin during that window must
   * not leave a pairing or a push believing the instance is still alive.
   */
  private active = false;

  private socket: SyncSocket | null = null;
  private pump: Pump | null = null;
  private fetcher: Fetcher | null = null;
  private settler: Settler | null = null;
  /** Pulls owed after a merged or conflicted push — see `attemptPull`. */
  private readonly pendingPulls = new Map<
    string,
    { path: string; pushed: string; vault: string; attempts: number; timer: number | null }
  >();
  private touched: Touched = emptyTouched();
  /** Guards a settle's own derive-and-push pass; re-armed rather than interleaved. */
  private syncing = false;
  /** The derive half of that pass is running: local work that ends on its own, so an idle
   * close during it never parks (`decideIdleWake`). */
  private deriving = false;

  private odd: ReadonlyMap<string, string> = new Map();
  /** Paths the last scan skipped because another file folds onto the same wire path. */
  private shadowed: readonly string[] = [];
  /**
   * Paths the last derive that looked at them decided not to send: too large for a frame,
   * or bytes that are not UTF-8.
   *
   * **A set that survives the settle, not a per-settle count**, and that is the whole
   * reason this field exists rather than a one-line `undecodable.length` at the `setStatus`
   * below. A derive only ever visits the paths in THIS settle's `touched`, so a count taken
   * from its result alone reads 3 in the window the bad file was edited and 0 in every
   * window after it — the user watches the warning appear and vanish while the file is
   * still sitting there unsynced, which is the reported failure with an extra flicker on
   * top. Membership is refreshed the only honest way: every path this settle actually
   * re-examined is dropped first, and whatever the derive withheld goes back in.
   */
  private withheld = new Map<string, "oversize" | "undecodable">();
  /**
   * Files the server refused for good, with its reason — the paths behind
   * `SyncStatus.refused`. Keyed by path, so a file refused twice is one file, not two.
   */
  private refusedFiles = new Map<string, string>();
  /** Files the server can no longer send (O3) — the paths behind `SyncStatus.unavailable`. */
  private unavailableFiles = new Set<string>();

  /**
   * The vault closed an idle connection and this device holds none (vault-sleep design VS4).
   * The `SyncSocket` and `Pump` are kept: `wake` reconnects the same pair, as a resumable
   * closing does. Cleared by `wake`, so a second trigger while the first is still connecting
   * does nothing.
   */
  private parked = false;
  /**
   * The next `ready` reconnects a pair whose watchers kept running, so it skips the full
   * rescan (VS5): it ends a park (`onIdle`) or a closing the vault said to retry after
   * (`onClosing`, BI1 — a busy import closes every few seconds). Cleared by that `ready` and
   * by `disconnectSyncing`, not by a failed reconnect in between. A plain drop, and a closing
   * before this pair's first `ready` (`readiedThisPair`), still rescan.
   */
  private watchersRan = false;
  /**
   * A mobile device went to the background since the last `ready` (VS5's exception). A
   * backgrounded mobile app's JavaScript is suspended, so an edit made by something else in
   * that time — a file-sync app, a git client — may reach no watcher at all. The rescan VS5
   * skips for a desktop that was running throughout is exactly what finds it, so the next
   * `ready` does it.
   */
  private backgroundedOnMobile = false;
  /** This `SyncSocket`/`Pump` pair has completed a handshake at least once. Cleared by
   * `disconnectSyncing`, with the pair. */
  private readiedThisPair = false;
  /** A manifest reconcile is running (`startReconcile`). */
  private reconciling = false;
  /** Another reconcile was asked for while one was running: run once more when it ends. */
  private reconcileAgain = false;
  /** Consecutive idle closes answered by reconnecting at once — `park.ts`'s
   * `decideIdleWake`. Reset by a quiet close, and by any sign the vault is answering. */
  private idleWakes = 0;
  /** What the signal poll has already woken for — `park.ts`'s `decideSignalWake`. */
  private signalMemory: SignalMemory = FRESH_SIGNAL_MEMORY;
  /** A signal poll is in flight. One at a time: a slow control plane must not stack them. */
  private polling = false;
  /** A jittered signal wake, pending (`WAKE_JITTER_MS`). */
  private wakeTimer: number | null = null;

  private status: SyncStatus = IDLE_STATUS;
  private statusListeners = new Set<(status: SyncStatus) => void>();
  private pairingListeners = new Set<() => void>();

  /**
   * D19's tap, as a seam.
   *
   * **A seam, not a policy knob.** The shipped default is the real modal; a test replaces
   * it because a `Modal` needs a DOM this suite does not have, exactly as `ready` above is
   * a seam nothing in the plugin reads. Nothing here ever sets it to something that answers
   * on a human's behalf — `adopt.ts` carries why that matters.
   */
  confirmAdoption: ConfirmAdoption = (offer: AdoptionOffer) => askToAdopt(this.app, offer);

  /**
   * The clock, as a seam — the same shape `pairing-intent.ts` uses for its own.
   *
   * A routing proof is bound to a timestamp and the control plane checks it
   * against a window, so a test needs to be able to place one outside that
   * window without sleeping.
   */
  now: () => number = () => Date.now();

  /** The wake jitter's randomness, as a seam for the same reason `now` is one. */
  random: () => number = () => Math.random();

  /**
   * The one pairing this device is working on, or `null`.
   *
   * Single-flight: a second Pair press, or a nudge arriving mid-flow, joins nothing and
   * starts nothing. Two concurrent runs would race to redeem the same pairing and to write
   * the same two settings.
   */
  private pairingRun: Promise<void> | null = null;

  /** Cancels an in-flight pairing poll on unload — the one long-lived timer this plugin
   * owns beside the settler. Field-initialised, not created in `onload`: `onunload` can
   * run before `onload` finishes awaiting the device identity. */
  private readonly pairingAborter = new AbortController();

  /**
   * Stops THIS pairing's poll — "Cancel pairing" in the pane. One per run, and aborted too
   * when the plugin unloads, so a run has one signal to watch rather than two.
   */
  private pairingRunAborter: AbortController | null = null;

  /**
   * Detaches the current run's listener from `pairingAborter`, which lives as long as the
   * plugin does. Without it every pairing this session started left one listener — and the
   * run's controller it closes over — on that signal until unload.
   */
  private releasePairingSignal: (() => void) | null = null;

  /**
   * Resolves once load-time setup — the device identity, and a resumed connection if this
   * device was already paired — has finished. A seam for tests, exactly like an earlier prototype's
   * `ready`: nothing in the plugin reads it.
   */
  ready: Promise<void> = Promise.resolve();

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  // ---- SettingsHost (settings-tab.ts owns this contract; this class only satisfies it) ----

  get controlplaneOrigin(): string {
    return this.cfg.controlplaneOrigin;
  }

  get vaultId(): string {
    return this.cfg.vaultId;
  }

  get deviceId(): string | null {
    return this.cfg.deviceId;
  }

  get webAppOrigin(): string {
    return this.cfg.webAppOrigin;
  }

  /** Whether this device is waiting on a browser. The settings pane renders a row from it;
   * it deliberately exposes nothing ABOUT the pairing, because there is nothing in one a
   * pane may show (rule 1, rule 5). */
  get pairingInFlight(): boolean {
    return this.pairingRun !== null;
  }

  get vaultName(): string {
    return this.app.vault.getName();
  }

  async setControlplaneOrigin(value: string): Promise<void> {
    this.cfg = { ...this.cfg, controlplaneOrigin: value };
    await this.saveData(this.cfg);
  }

  async setWebAppOrigin(value: string): Promise<void> {
    this.cfg = { ...this.cfg, webAppOrigin: value };
    await this.saveData(this.cfg);
  }

  syncStatus(): SyncStatus {
    return this.status;
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onPairingChange(listener: () => void): () => void {
    this.pairingListeners.add(listener);
    return () => {
      this.pairingListeners.delete(listener);
    };
  }

  skippedFiles(): readonly SkippedFile[] {
    const files: SkippedFile[] = [];
    for (const path of this.shadowed) files.push({ path, kind: "clash" });
    for (const [path, kind] of this.withheld) files.push({ path, kind });
    for (const [path, detail] of this.refusedFiles) files.push({ path, kind: "refused", detail });
    for (const path of this.unavailableFiles) files.push({ path, kind: "unavailable" });
    return files;
  }

  /**
   * `GET /v1/sync/overview` (`overview.ts`), proved with the same query as the socket and the
   * signal poll — `routingProof` below, minted fresh because it carries a 30-second window.
   * Bounded like the signal poll: a pane waiting on a half-open connection would say
   * "Loading" until Obsidian restarted.
   */
  async loadOverview(): Promise<OverviewResult> {
    if (!this.isPaired()) return { status: "failed", reason: "not_paired" };
    const proof = await this.routingProof();
    return fetchOverview(this.cfg.controlplaneOrigin, proof, (origin, path) =>
      this.boundedRequest(origin, path),
    );
  }

  openInBrowser(url: string): void {
    void openInSystemBrowser(url);
  }

  /**
   * The pair page again, for the intent this device is already waiting on — the link
   * `pairPageUrl` rebuilds from the persisted id, exactly as `startPairing`'s own
   * `browser_failed` branch says it can be. Registers nothing: a second intent would strand
   * the first, and the poll that is running is for this one.
   */
  reopenPairingPage(): boolean {
    if (this.pairingRun === null || this.cfg.webAppOrigin === "") return false;
    const state = loadPairingState(this.app);
    if (state === null) return false;
    void openInSystemBrowser(pairPageUrl(this.cfg.webAppOrigin, state.intentId));
    return true;
  }

  /**
   * Stop waiting on the browser. The intent is forgotten locally and its poll stopped; the
   * server's copy simply expires, which is what an unfinished intent does anyway and grants
   * nothing (D16). The pane redraws when the run ends, through `endPairingRun`.
   */
  cancelPairing(): void {
    clearPairingState(this.app);
    this.pairingRunAborter?.abort();
  }

  /**
   * "Try again" in the pane, and "Sync now" from the palette, after a refusal ended syncing.
   *
   * **The one clean restart this class has is `startSyncing`**, and it is safe here for the
   * reason it is safe at load: a terminal closing ran `disconnectSyncing`, so there is no
   * socket, pump or fetcher left to leak or to race — exactly the state a fresh load is in.
   * Nothing about the registration changes. If the vault refuses again, `onClosing` puts the
   * refusal back; if it accepts, `ready` clears it.
   *
   * **The refusal moves to `retrying` for the wait**, so the pane and the status bar say
   * "Reconnecting" — still quoting what the vault said last, and still with its advice when
   * that was "not authorised" — rather than a refusal the user has just asked to be retried.
   * `ready` clears it, and a second refusal puts `refusal` back (`disconnectSyncing` clears
   * `retrying` on the way).
   */
  retrySyncing(): void {
    if (!this.active || !this.isPaired() || this.socket !== null) return;
    this.setStatus({ refusal: null, retrying: this.status.refusal ?? this.status.retrying });
    void this.startSyncing();
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of snapshot(this.statusListeners)) listener(this.status);
  }

  private notifyPairingChange(): void {
    for (const listener of snapshot(this.pairingListeners)) listener();
  }

  /** All three fields configured. The honest default (its own test) is that an
   * unpaired plugin does nothing at all — no connection, no retry, no repeated warning. */
  private isPaired(): boolean {
    return (
      this.cfg.deviceId !== null && this.cfg.vaultId !== "" && this.cfg.controlplaneOrigin !== ""
    );
  }

  /**
   * Whether this device carries attachments — images and the rest of what is not text.
   *
   * **`false` on every device until the vault could hold one.** `apply_upload` used to
   * run `String::from_utf8` over every completed upload and refuse whatever failed, so
   * desktop derived, read, hashed and streamed an attachment's full bytes only to have
   * each one refused — wasted work, and a permanently non-zero refusal counter for files
   * a user has every reason to expect sync to carry. The vault now has that path:
   * `Op::PutBytes` stores bytes and requires text only where the content is projected
   * (`projections::projects_content` — a note or a `.base`), so the reason to hold every
   * device back is gone and this is `!Platform.isMobile` again.
   *
   * **Mobile still does not, and that is a device preference rather than a limitation**
   * (PLUGIN §5.2): a phone on a metered connection should not pull a vault's worth of
   * images, and the wire has carried this as a per-device flag from the start.
   *
   * Size is NOT decided here. `derive.ts` stats every path before reading it and skips
   * anything past `MAX_FRAME_BYTES`, reporting it as `oversize` so the shell can say so —
   * which is what keeps a 12-megapixel photo from being read into memory only to be
   * refused by the frame bound at the other end.
   */
  private get attachments(): boolean {
    return !Platform.isMobile;
  }

  // ---- lifecycle ----

  override onunload(): void {
    this.active = false;
    this.pairingAborter.abort();
  }

  override async onload(): Promise<void> {
    this.active = true;

    // **Registered before the first `await`, deliberately.** A callback can arrive during a
    // plugin reload — the browser step finishes while Obsidian is restarting this plugin —
    // and a handler registered only while a pairing is in flight misses exactly that case.
    // It is safe to be reachable when nothing is pairing: with no persisted intent the
    // nudge is a no-op, which is the whole of what a callback is allowed to be (D15).
    //
    // **Every entry in `PAIRED_ACTIONS`, not the first.** Which reading Obsidian dispatches
    // under is not knowable from here (see that constant); claiming both costs one line and
    // exactly one of them ever fires.
    for (const action of PAIRED_ACTIONS) {
      this.registerObsidianProtocolHandler(action, (params) => this.onPairedCallback(params));
    }

    const stored = (await this.loadData()) as Partial<Settings> | null;
    this.cfg = { ...DEFAULT_SETTINGS, ...stored };

    this.identity = await DeviceIdentity.load(this.app);
    if (!this.active) return; // Disabled while the identity load was in flight.

    if (this.cfg.vaultId !== "") {
      adoptUnstampedState(this.app, this.cfg.vaultId);
      this.syncState = loadSyncState(this.app, this.cfg.vaultId);
    }

    this.addSettingTab(new CtrlNotesSettingsTab(this.app, this));
    this.showStatusBar();

    this.register(() => this.disconnectSyncing());
    this.watchVault();
    this.watchForReturn();

    // **The mobile cold-launch case D13 exists for** (§5.1). Obsidian is backgrounded the
    // moment the system browser takes the foreground and may be killed there, so the
    // process that started a pairing is routinely not the one that finishes it. Everything
    // needed to finish is on disk; this is what picks it up again. Not awaited into
    // `ready`: a pairing waits on a human, and `ready` is about this device's own load.
    this.resumePairing();

    if (this.isPaired()) {
      this.ready = this.startSyncing();
    }
  }

  /**
   * The ambient status: an icon and one word in Obsidian's status bar, the full sentence as
   * its label, and a click — or Enter or Space, from the keyboard — that opens this plugin's
   * settings.
   *
   * **A button to assistive technology, not a span with a click handler.** `role="button"`
   * is what makes a screen reader announce the `aria-label` as the control's name (on a bare
   * `div` it is not reliably read at all), and `tabindex="0"` puts it in the tab order, where
   * a keyboard user can reach something a mouse user can. The key handler is the other half
   * of that: a focusable button that ignores Enter is worse than none.
   *
   * **Desktop only.** Obsidian's mobile app has no status bar, and a mobile user has the
   * settings pane.
   *
   * Native classes only (`mod-clickable`, `status-bar-item-icon`), so the plugin still ships
   * no stylesheet: a `styles.css` would be a third release asset, which `tools/release.mjs`
   * would then demand of every release, including the ones already published without it.
   */
  private showStatusBar(): void {
    if (Platform.isMobile) return;
    const item = this.addStatusBarItem();
    item.addClass("mod-clickable");
    item.setAttr("role", "button");
    item.setAttr("tabindex", "0");
    item.setAttr("data-tooltip-position", "top");
    const icon = item.createSpan({ cls: "status-bar-item-icon" });
    // **The gap is a character, not a style.** Obsidian's own status-bar items are icon-only,
    // so nothing native spaces an icon from a word: measured in 1.13.7, the two touched
    // ("⚠Error"). With no stylesheet (above), a no-break space is the one gap that cannot
    // collapse. A screen reader never reads it: with `role="button"` the `aria-label` is the
    // item's accessible name, and it carries the whole sentence in place of icon and word.
    item.createSpan({ text: " " });
    const word = item.createSpan();
    const draw = (): void => {
      const face = statusBarFace(this.isPaired() ? this.status : null);
      setIcon(icon, face.icon);
      word.setText(face.text);
      item.setAttr("aria-label", face.label);
    };
    draw();
    this.register(this.onStatusChange(draw));
    this.register(this.onPairingChange(draw));
    this.registerDomEvent(item, "click", () => this.openOwnSettings());
    this.registerDomEvent(item, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space would otherwise scroll whatever pane is behind the status bar.
      event.preventDefault();
      this.openOwnSettings();
    });
  }

  /**
   * Open Settings at this plugin's tab.
   *
   * **`app.setting` is not in `obsidian.d.ts`**, so it is reached through a narrow type and
   * checked before each call rather than assumed. It is the object Obsidian's own "Open
   * settings" command drives, and plugins have used `open` and `openTabById` for years; if a
   * release ever removes them, the click does nothing rather than throwing.
   */
  private openOwnSettings(): void {
    const setting = (this.app as unknown as { setting?: Partial<SettingsModal> }).setting;
    if (typeof setting?.open !== "function" || typeof setting.openTabById !== "function") return;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  /**
   * An `obsidian://ctrlnotes/paired` callback.
   *
   * **It carries nothing and can do nothing but start a poll that was going to run anyway**
   * (D15). `protocol.ts` decides whether this callback is even ours; the most a `nudge` may
   * do is what it does here. It does not shorten a poll already running: the interval is two
   * seconds, and a wake path would mean a second signal in a loop whose only other signal
   * means cancel, for two seconds of a wait on a human.
   */
  private onPairedCallback(params: Readonly<Record<string, string>>): void {
    const outcome = handleProtocol(params, this.app.vault.getName());
    if (outcome.action !== "nudge") return;
    this.resumePairing();
  }

  // ---- pairing (design §5: intent → browser → signed retrieval → D19's tap) ----
  //
  //   startPairing   register an intent, persist it, open the SYSTEM browser  (D2, D13)
  //   resumePairing  the same flow minus the first two steps, after a cold launch or a
  //                  callback — everything it needs is the persisted intent id  (D15)
  //   awaitAndAdopt  poll `…/challenge` + `…/result` by proving possession of the device
  //                  key (D14), then hand a bound result to the gate
  //   adopt          `adopt.ts`'s D19 gate: ask a human HERE, and only then redeem,
  //                  persist and upload
  //
  // **The plugin sends no vault id and knows none until the gate closes** (D9, D11). The
  // browser picks the vault, from the vaults its own session owns.

  async startPairing(label: string): Promise<void> {
    if (this.pairingRun !== null) {
      new Notice(`This device is already waiting to be connected to ${PRODUCT_NAME}.`);
      return;
    }
    if (this.identity === null) return; // Not reachable in practice: onload loads it first.
    const run = this.beginPairing(label, this.newPairingSignal());
    this.pairingRun = run;
    try {
      await run;
    } finally {
      this.endPairingRun(run);
    }
  }

  /**
   * Clear the single-flight slot and tell the settings pane.
   *
   * **The notify belongs HERE, after the slot is cleared, not at each outcome.** The pane
   * renders "Waiting for your browser" from `pairingInFlight`, and every outcome inside
   * `awaitAndAdopt`/`adopt` fires while the run is still the current one — so a notify from
   * there redraws the waiting row it was supposed to replace, and nothing redraws again.
   * Adoption happens to escape that (a device id outranks the waiting row), which is
   * exactly the shape of bug that ships: the success path looks right and every refusal
   * leaves the pane lying.
   */
  private endPairingRun(run: Promise<void>): void {
    if (this.pairingRun !== run) return;
    this.pairingRun = null;
    this.releasePairingSignal?.();
    this.releasePairingSignal = null;
    this.notifyPairingChange();
  }

  /**
   * A fresh abort signal for one pairing run, fired by "Cancel pairing" or by unload. The
   * unload half is a listener on the plugin-lifetime signal, removed again by
   * `endPairingRun` (`releasePairingSignal`).
   */
  private newPairingSignal(): AbortSignal {
    const run = new AbortController();
    this.pairingRunAborter = run;
    this.releasePairingSignal?.();
    this.releasePairingSignal = null;
    if (this.pairingAborter.signal.aborted) {
      run.abort();
    } else {
      const onUnload = (): void => run.abort();
      const lifetime = this.pairingAborter.signal;
      lifetime.addEventListener("abort", onUnload, { once: true });
      this.releasePairingSignal = () => lifetime.removeEventListener("abort", onUnload);
    }
    return run.signal;
  }

  private async beginPairing(label: string, signal: AbortSignal): Promise<void> {
    const identity = this.identity;
    if (identity === null) return;

    const started = await registerPairingIntent(this.app, {
      controlplaneOrigin: this.cfg.controlplaneOrigin,
      webAppOrigin: this.cfg.webAppOrigin,
      // base64url, no padding — §8 pins the intent hops to that alphabet. The redemption
      // hop is the STANDARD-alphabet exception, and `adopt.ts` converts there.
      publicKeyBase64: identity.publicKeyBase64,
      openInSystemBrowser,
    });
    if (!this.active) return; // The plugin was disabled while we were asking.
    if (!started.ok) {
      new Notice(
        failureMessage(
          `Could not start pairing with ${PRODUCT_NAME}.`,
          started.reason,
          "could not start pairing",
        ),
      );
      // **`browser_failed` left a live, persisted intent behind** (`pairing-intent.ts`
      // keeps it on purpose), so this device waits on it like any other: the pane's "Open
      // browser again" rebuilds the link, and its Notice says so. Every other refusal left
      // nothing to wait on.
      if (started.reason !== "browser_failed") return;
      // Cancelled while the intent was being registered — the same case the success path
      // handles below, and the intent is just as persisted here: `browser_failed` is the
      // refusal that keeps it on purpose. Returning without clearing it left a live intent
      // on disk that the next load would resume, as if Cancel had never been pressed.
      if (signal.aborted) {
        clearPairingState(this.app);
        return;
      }
      const kept = loadPairingState(this.app);
      if (kept === null) return;
      this.notifyPairingChange();
      await this.awaitAndAdopt(kept, label, signal);
      return;
    }
    // Cancelled while the intent was being registered: it is persisted by now, so it goes.
    if (signal.aborted) {
      clearPairingState(this.app);
      return;
    }
    this.notifyPairingChange();
    new Notice("Finish connecting this device in your browser.");
    await this.awaitAndAdopt(started.value.state, label, signal);
  }

  /**
   * Pick a persisted pairing back up — after a cold launch, or on an `obsidian://` nudge.
   *
   * Fire-and-forget by design: both callers are events, not requests, and the flow ends at
   * a human. Does nothing at all when this device is not pairing, which is the ordinary
   * case for both.
   */
  private resumePairing(): void {
    if (this.pairingRun !== null) return;
    const state = loadPairingState(this.app);
    if (state === null) return;
    // `vault.getName()` rather than a stored label: it is what the settings tab passes on
    // the Pair press too, and a label is display text the user can change later anyway.
    const run = this.awaitAndAdopt(state, this.app.vault.getName(), this.newPairingSignal());
    this.pairingRun = run;
    this.notifyPairingChange();
    void run.finally(() => {
      this.endPairingRun(run);
    });
  }

  /**
   * Wait for a signed-in browser to bind a pairing to this intent, then offer it.
   *
   * **Every completion of a pairing passes through the `this.active` guard below**, for the
   * reason the old flow's own comment gave and which has not changed: `requestUrl` has no
   * abort, so a response already on the wire lands whatever the signal says.
   */
  private async awaitAndAdopt(
    state: PairingState,
    label: string,
    signal: AbortSignal,
  ): Promise<void> {
    const identity = this.identity;
    if (identity === null) return;

    const settled = await retrieveWhenBound(this.cfg.controlplaneOrigin, state, identity, signal);
    if (!this.active) return;

    switch (settled.status) {
      case "cancelled":
        // Unloading, or "Cancel pairing" — which already forgot the intent, and whose pane
        // redraws when this run ends. Nobody needs telling either way.
        return;
      case "expired":
        // Forgotten rather than kept: an intent past its deadline can never bind, so
        // keeping it would have every later load resume a poll that reports the same thing
        // again. The recovery is the one the user already knows — press Pair.
        this.forgetPairing();
        new Notice(
          "This pairing request expired before it was completed. Pair this device again to continue.",
        );
        return;
      case "redeemed":
        // **Terminal, and the user must pair again.** `adopt.ts` keeps the intent after a
        // failed redemption so this arm can say *what* happened rather than nothing — but
        // saying so is all it can do. `retrieve_pairing_result` answers a redeemed intent
        // with `pairing_id` and `vault_id` and no `device_id`, so there is no record to
        // adopt from; and even with one, the consent that authorised it belonged to a
        // process that has since gone (D19 is a tap on THIS device, in THIS run). Adopting
        // here would be adopting without one.
        this.forgetPairing();
        new Notice(
          "This pairing request has already been used. Pair this device again to continue.",
        );
        return;
      case "refused":
        // A 4xx is the server's considered answer about this intent (AT8 folds unknown,
        // expired and unverifiable into one refusal on purpose), so it cannot change by
        // being asked again.
        this.forgetPairing();
        new Notice(
          failureMessage(
            `Could not finish pairing with ${PRODUCT_NAME}.`,
            settled.reason,
            "the pairing request was refused",
          ),
        );
        return;
      case "bound":
        await this.adopt(state, settled.pairing, label);
        return;
    }
  }

  /**
   * **Spec D19, and the only step a human takes on the device itself.** `adopt.ts` owns the
   * ordering and the reasoning; this method owns what the plugin does with each answer.
   *
   * Everything the gate is allowed to do is handed to it here, so that "nothing is
   * persisted, redeemed or uploaded before the tap" is one readable function over there
   * rather than a property of this class's control flow.
   */
  private async adopt(state: PairingState, pairing: BoundPairing, label: string): Promise<void> {
    const identity = this.identity;
    if (identity === null) return;
    const origin = this.cfg.controlplaneOrigin;

    const outcome = await offerAdoption(
      { pairing, deviceLabel: label, obsidianVaultName: this.app.vault.getName() },
      {
        confirm: (offer) => this.confirmAdoption(offer),
        // The same hop `retrieveWhenBound` just ran, once more, after the tap: the
        // assertion it read is two minutes old at most and a human is not on a timer.
        // `state.intentId` is this device's OWN persisted id, never one read out of a
        // response — the same rule `attemptRetrieval` states for the poll.
        refresh: () => retrieveOnce(origin, state.intentId, identity),
        redeem: (offer, assertion) =>
          redeemPairing(
            origin,
            offer.pairingId,
            // STANDARD base64 here and base64url on the three intent hops (§8). The two
            // alphabets sit on adjacent surfaces in this flow, so each is stated where it
            // is used rather than inferred from the other.
            publicKeyStandardBase64(identity),
            offer.deviceLabel,
            assertion,
          ),
        persist: (vaultId, deviceId) => this.adoptVault(vaultId, deviceId),
        // A device that was already loaded when pairing completed never saw Obsidian's own
        // `create` replay (that fires once, on load — `watchVault`'s own note), so without
        // this a freshly connected device with a full pre-existing vault sits connected and
        // reports nothing to push.
        seedInitialUpload: () => this.seedInitialUpload(),
        forgetIntent: () => clearPairingState(this.app),
        stillActive: () => this.active,
      },
    );

    // Unloaded while the modal was open, or mid-redemption. Nobody is left to tell, and a
    // listener notified here is one holding a settings pane that has already gone.
    if (outcome.status === "abandoned") return;

    switch (outcome.status) {
      case "unredeemable":
        // O2: a control plane with no signing key configured. Production's was minted
        // 2026-09-09, so this is a self-hosted or development build without one. Named
        // rather than left as a silent dead end, and nobody was asked to consent to
        // something that cannot complete.
        this.forgetPairing();
        new Notice(
          `This ${PRODUCT_NAME} control plane cannot finish pairing: it has no signing key ` +
            "configured.",
        );
        return;
      case "declined":
        // The gate already dropped the intent; this is only the pane catching up.
        this.notifyPairingChange();
        new Notice(`This device was not connected to ${PRODUCT_NAME}.`);
        return;
      case "mismatch":
        // The re-read after the tap named a different pairing or vault than the dialog
        // showed. The gate already dropped the intent and redeemed nothing; the user is
        // told plainly, because this is the one refusal that is worth being suspicious of.
        this.notifyPairingChange();
        new Notice(
          `This device was not connected to ${PRODUCT_NAME}. The pairing changed after you ` +
            "confirmed it. Start again, and cancel if you are asked twice.",
        );
        return;
      case "failed":
        this.notifyPairingChange();
        new Notice(
          failureMessage(
            `Could not pair with ${PRODUCT_NAME}.`,
            outcome.reason,
            "redemption failed",
          ),
        );
        return;
      case "adopted":
        this.notifyPairingChange();
        new Notice(`Paired with ${PRODUCT_NAME}.`);
        // **Disconnected first, and not only for tidiness.** `SyncSocket` is constructed
        // with the vault id it will sign every challenge for, so a connection opened for
        // the PREVIOUS vault keeps signing for that one — and `startSyncing` returns early
        // while a socket exists, so it would never be replaced. A device re-paired to a
        // different vault would then report itself connected to the new one and go on
        // syncing the old.
        this.disconnectSyncing();
        // `seedInitialUpload` already ran, inside the gate. Not pushed directly: nothing is
        // connected yet, and the settle → derive pipeline picks it up once `ready` arrives.
        void this.startSyncing();
        return;
    }
  }

  /**
   * Write the adopted vault id and device id, and pick up this device's ledger for that
   * vault.
   *
   * **`adoptUnstampedState` is deliberately NOT called here**, unlike at load. That claims
   * an unstamped legacy record for "the vault this device is linked to", which at load is
   * this device's own; here the vault has just been chosen and may not be the one that
   * record describes. A ledger that does not match simply reads as empty, which costs one
   * full re-push and cannot mis-attribute anything.
   */
  private async adoptVault(vaultId: string, deviceId: string): Promise<void> {
    this.cfg = { ...this.cfg, vaultId, deviceId };
    await this.saveData(this.cfg);
    this.syncState = loadSyncState(this.app, vaultId);
    // The `seq`s it remembers were another vault's, and would hold this one's back.
    this.signalMemory = FRESH_SIGNAL_MEMORY;
  }

  /** Drop the persisted intent and tell the settings pane. This device is no longer waiting
   * on a browser. */
  private forgetPairing(): void {
    clearPairingState(this.app);
    this.notifyPairingChange();
  }

  /**
   * **"Disconnect this device" — local, and honest about it** (design §6.3).
   *
   * Renamed from `unpair`, and the rename is load-bearing: no revoke path is reachable from
   * the plugin (hop 2 needs a browser-minted grant, the vault's own `DELETE
   * /v1/devices/{id}` needs the operator static token), so the vault row stays trusted
   * until somebody removes it from the device list. A button called "Unpair" beside a
   * device list the user cannot see invites them to believe they have cut off a lost
   * laptop. `settings-tab.ts` carries the sentence that says otherwise.
   *
   * **The key goes, not just the settings.** A device id is not a credential — forgetting
   * one while leaving the private key in `secretStorage` leaves a working credential for a
   * vault the user believes they have left. Destroying it is the one half of a revocation a
   * device can honestly perform on its own, and `device.ts`'s `forgetDeviceKey` says what
   * that costs.
   *
   * **A fresh identity is loaded immediately**, rather than leaving `identity` null:
   * `startPairing` returns silently on a null identity, so a device that disconnected would
   * find the Pair button dead for the rest of the session.
   */
  async disconnect(): Promise<void> {
    this.disconnectSyncing();
    // Both, not just the device id. The vault was adopted as part of this registration
    // (D11) and means nothing without it — leaving it behind would show a pane naming a
    // vault this device can no longer reach, and `adoptVault` writes a new one on re-pair.
    this.cfg = { ...this.cfg, vaultId: "", deviceId: null };
    await this.saveData(this.cfg);
    await forgetDeviceKey(this.app);
    this.identity = await DeviceIdentity.load(this.app);
    // The status described the vault this device just left. Kept, a re-pair would open on
    // the old refusal ("Sync was refused" beside a device that has just been paired) until
    // its first `ready`, and "Show files" would list files of a vault it no longer syncs.
    // `shadowed` with them: it is recomputed from the listing on the next scan, but until one
    // runs "Show files" would go on listing clashes counted for the vault it left.
    this.shadowed = [];
    this.withheld.clear();
    this.refusedFiles.clear();
    this.unavailableFiles.clear();
    this.setStatus(IDLE_STATUS);
    // The status bar reads "Not paired" from this; the settings pane redraws on it too.
    this.notifyPairingChange();
  }

  private seedInitialUpload(): void {
    const paths = this.listWirePaths().filter((p) => syncablePath(p, this.attachments));
    for (const path of paths) this.touched.dirty.add(path);
  }

  /**
   * `reconcileManifest`, started and deliberately not awaited — with the `.catch()` both
   * call sites were missing.
   *
   * **A floating promise's rejection is a defect on its own.** Both sites spelled this
   * `void this.reconcileManifest().then(...)`, so anything the reconcile threw became an
   * unhandled rejection: no warning attributable to this plugin, no settle, and — because
   * the same thing fails the same way on every reconnect — no way for the user or for us to
   * tell it apart from a device that simply had nothing to send. `scanManifest` now guards
   * its own per-path reads, which removes the likeliest source; this covers the rest
   * (`listWirePaths`, `stat`, a bug here) rather than trusting that list to stay complete.
   *
   * **The settle runs either way.** A reconcile that threw part-way through has still
   * marked real paths dirty, and nothing else is ever going to look at them.
   *
   * **One at a time.** A scan reads and hashes every file, so on a large vault it can outlast
   * the gap between two reconnects. A request while one runs is served by ONE more scan when
   * it ends — not dropped, because the running scan may have listed the vault before the edit
   * the request exists to catch.
   */
  private startReconcile(): void {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    void (async () => {
      try {
        do {
          this.reconcileAgain = false;
          try {
            await this.reconcileManifest();
          } catch (e) {
            console.warn("Ctrl Notes: could not reconcile this vault against its own ledger", e);
          }
        } while (this.reconcileAgain && this.active);
      } finally {
        this.reconciling = false;
      }
      this.settler?.touch();
    })();
  }

  /**
   * Diff a full local scan against this device's own ledger and seed `touched` from the
   * difference. `manifest-scan.ts` was written, tested, and never called — its
   * own sibling `reconcile.ts` named the exact gap this closes: an edit made while this
   * device was not running at all, or a relink. The ordinary settle → derive pipeline
   * (unaffected by any of this) does everything else once a path is dirty; this function
   * only decides WHICH paths that is.
   *
   * Called from `onLayoutReady` (vault listing is stable and complete by then) and again on
   * every `ready` — a reconnect is the other moment this device could have missed something —
   * except the one that ends a park (VS5) or a retried closing (BI1), when the watchers were
   * running throughout.
   */
  private async reconcileManifest(): Promise<void> {
    const listed = this.listWirePaths();
    const scannable: ScannableVault = {
      ...this.vaultFiles(),
      list: async () => listed,
    };
    const entries = await scanManifest(scannable, { attachments: this.attachments });
    const onDisk = new Map(entries.map((e) => [e.path, e.sha] as const));

    for (const [path, sha] of onDisk) {
      if (this.syncState.hashes[path] !== sha) this.touched.dirty.add(path);
    }
    // A path Obsidian LISTS that the scan produced no entry for is not gone — the scan
    // could not hash it (vanished mid-scan, unreadable, or bytes that are not text), and
    // its own comment says absence means "not claimed". Making it dirty rather than
    // leaving it silent hands the question to `deriveChanges`, which stats first and
    // answers it precisely: nothing at all if it really did vanish, a named `undecodable`
    // the user is warned about if its bytes are not UTF-8, and an ordinary push if the
    // read was only transiently failing. This is the only thing between a withheld file
    // and the user never hearing about it.
    for (const path of listed) {
      if (onDisk.has(path) || !syncablePath(path, this.attachments)) continue;
      this.touched.dirty.add(path);
    }
    // A path this device once synced (it is in the ledger) that Obsidian no longer LISTS
    // was deleted while this device could not see it — the same reasoning `derive.ts`'s
    // `touched.deleted` branch already applies to a live `delete` event.
    //
    // **The listing, not the scan's entries.** `scanManifest` drops a path it could not
    // hash — gone mid-scan, unreadable, or (since the content gate) bytes that are not
    // text — and its own comment says so: absence from those entries means "not claimed",
    // never "not on disk". Reading a deletion out of it pushed a `delete` for a file
    // sitting on this disk, and the vault propagated that to every other device. A path
    // still in the listing is still here, whatever the scan could make of it.
    const present = new Set(listed);
    for (const path of Object.keys(this.syncState.hashes)) {
      if (present.has(path) || !syncablePath(path, this.attachments)) continue;
      this.touched.deleted.add(path);
      this.touched.dirty.delete(path);
    }
  }

  // ---- transport (Tasks 9-10's SyncSocket/Pump, wired to this vault) ----

  /**
   * A vault has no public address (provisioner D4), so this connects through the control
   * plane's own `GET /v1/sync` (`apps/controlplane/src/http/routes/mcp.rs`'s `get_sync`),
   * proving possession of the device key in the QUERY STRING: a standard `WebSocket` — the
   * only kind this plugin can use on both desktop and mobile — cannot attach a header to an
   * upgrade request. That proof authorises routing and nothing else; the vault then runs
   * its own device challenge.
   *
   * This comment used to describe the route wanting an agent-token bearer header, so that
   * every connection 401'd before reaching a vault. That was device-approval O6, found
   * while wiring this up and closed by #46 (2026-08-29). Every socket/pump test here drives
   * `SyncSocket` against a fake, and `dev/sync-demo` dialled the vault directly, which is
   * why nothing caught it sooner.
   */
  private async startSyncing(): Promise<void> {
    if (!this.isPaired() || this.identity === null || this.socket !== null) return;

    const pump = new Pump(this.pumpDeps());
    this.pump = pump;

    // One fetcher per CONNECTION, not per plugin: its correlation is positional
    // and only meaningful within a single socket, and `reset` on disconnect is
    // what fails outstanding fetches as transient so they retry rather than hang.
    const fetcher = new Fetcher({
      // `SyncSocket.send` throws before the handshake completes rather than
      // returning a flag, so "there is no socket to ask" is a catch, not a
      // false. The fetcher turns that into a TRANSIENT failure, which is right:
      // a reconnect is exactly when retrying works.
      send: (up) => {
        try {
          this.socket?.send(up);
          return this.socket !== null;
        } catch {
          return false;
        }
      },
    });
    this.fetcher = fetcher;

    const socket = new SyncSocket(
      {
        // Minted per connection: the control plane needs a signed, short-lived
        // routing proof to know which vault to replay this socket into (O6),
        // and it must travel in the query string because a `new WebSocket(url)`
        // can set no headers.
        url: () => this.syncUrl(),
        vaultId: this.cfg.vaultId,
        deviceId: this.cfg.deviceId ?? "",
        identity: this.identity,
        createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        // BI4: a settle deriving or pushing, a push in flight, or an edit not yet derived —
        // work only a connection can finish, so the vault must not sit quiet long enough to
        // suspend in the middle of it.
        hasWork: () =>
          this.syncing ||
          (this.pump?.hasOutstanding() ?? false) ||
          hasSomethingToSend(this.touched, this.attachments),
        // The bytes following a `blob` header. They mean nothing on their own —
        // the fetcher owns the header that gives them a destination.
        onBytes: (bytes) => {
          fetcher.onBytes(bytes);
        },
        onFrame: (down: Down) => {
          if (down.type === "ready") {
            // A fresh connection (first handshake, or any reconnect): retry whatever was
            // in flight when the last one died (§11's content-addressing makes that safe),
            // and flush anything the user edited while disconnected.
            //
            // The batch limits first (BI5): they belong to THIS connection's vault, and the
            // re-send `resume` makes is planned against them.
            pump.setBatchLimits(batchLimitsFrom(down));
            pump.resume();
            this.settler?.touch();
            // A reconnect is also a relink's most likely moment — re-scan the
            // manifest so anything the watcher missed while this device was disconnected
            // (or plain not running) gets picked up too, not only what a live event caught.
            //
            // **Except the reconnect that ends a park** (VS5). A parked device was running
            // the whole time and its watchers saw every edit, so the scan would find nothing
            // — and it reads every file, so a large vault would pay a full scan each time a
            // phone came back to the foreground.
            //
            // Nor after a closing the vault said to retry (BI1): see `watchersRan`.
            //
            // A mobile device that went to the background meanwhile rescans anyway: its
            // watchers were suspended with the rest of its JavaScript.
            const watched = this.watchersRan && !this.backgroundedOnMobile;
            this.watchersRan = false;
            this.backgroundedOnMobile = false;
            this.readiedThisPair = true;
            if (!watched) this.startReconcile();
            this.retryPendingPulls();
            // **Not `down.seq`.** That is the VAULT's current position, and
            // setting it here reported a device as caught up at the instant it
            // had applied nothing: measured, a device holding none of an
            // 84-event vault displayed `syncedCursor: 84` while its own ledger
            // read `{"cursor": 0}`. The settings pane renders this number, so
            // the plugin was telling a user it was current while writing
            // nothing — which is how a missing frame sat behind a green UI for
            // as long as it did, and it nearly inverted the experiment that
            // found it.
            //
            // The applied position is `syncState.cursor`, maintained by
            // `advanceCursor`, and it only moves for events this device
            // actually wrote.
            //
            // A completed handshake is also what ends a refused SESSION: `refusal` is
            // documented as "cleared by the next exchange that succeeds", and until
            // 2026-09-22 nothing cleared it, so a resumable closing that had already
            // reconnected kept the pane reading "Sync was refused" until a reload.
            // It ends the reconnect a retried closing started (BI1): `retrying` clears here.
            // And it ends a vault restart (staged rollout §5): `updating` clears here.
            this.setStatus({
              syncedCursor: this.syncState.cursor,
              refusal: null,
              retrying: null,
              updating: false,
              parked: false,
            });
            return;
          }
          // `blob`/`no_blob` answer a `want` this device sent; they are not
          // events and the pump has nothing to do with them.
          if (fetcher.onFrame(down)) return;
          void pump.handleDown(down);
        },
        onClosing: (message, willRetry) => {
          // A resumable closing (`socket.ts`'s own header) is already retrying
          // itself with backoff, on the SAME `SyncSocket`/`Pump` pair — tearing those down
          // here would abandon the very push or queue that retry is meant to resume, and
          // `startSyncing`'s only other entry point is a fresh pairing, not what this needs.
          //
          // **No `Notice` for it, and it is not a refusal** (BI1): a busy vault closes every
          // few seconds during an import and nothing is wrong. It used to raise a Notice and
          // set `refusal`, so a closing the device recovers from on its own popped
          // "Disconnected" and put "Sync was refused" at the head of the pane until the
          // reconnect landed. The status line says so instead (`status.ts`'s `retrying`), and
          // `ready` clears it.
          if (willRetry) {
            if (this.readiedThisPair) this.watchersRan = true;
            this.setStatus({ retrying: message, updating: false });
            return;
          }
          new Notice(`Sync with ${PRODUCT_NAME} stopped: ${asSentence(message)}`);
          this.setStatus({ refusal: message, updating: false });
          this.disconnectSyncing();
        },
        // The vault is restarting for an update (close 1012). No `Notice`: this is routine
        // and self-healing, and a popup on every rollout would teach users to ignore the
        // ones that matter. The status line says so, and the SAME `SyncSocket`/`Pump` pair
        // reconnects — nothing is torn down, exactly as for a resumable closing.
        onRestarting: () => {
          this.setStatus({ updating: true });
        },
        // The vault let go of an idle socket so its machine can sleep (VS1, VS4). No
        // `Notice` and no refusal: nothing is wrong. The pair is kept for `wake`, exactly as
        // for a restart. The fetcher is reset because its correlation belongs to the socket
        // that just closed, which fails any `want` still on it as transient.
        //
        // **The close does not mean nothing was outstanding.** The vault decides after 90 s
        // with no frame from this device, sends its closing and returns, so a frame sent in
        // the last round trip before that — a put, a want — is dropped, and a derive may
        // still be running. That work is read BEFORE the reset, which would hide the want.
        onIdle: () => {
          const outstanding = this.syncing || pump.hasOutstanding() || fetcher.hasOutstanding();
          fetcher.reset("parked");
          this.parked = true;
          this.watchersRan = true;
          this.setStatus({ parked: true, updating: false });
          // **Not parked with work outstanding.** Nothing else would wake the device for it:
          // `touched` was drained into that push, the vault never committed it so no signal
          // comes, and a focused window is never refocused. `ready` runs `pump.resume()`,
          // which re-sends the head (content addressing makes that safe), and
          // `retryPendingPulls`, which asks for a failed want again. Bounded: a vault that
          // never answers would otherwise be resumed every 90 s for good (`decideIdleWake`).
          const decided = decideIdleWake(outstanding, this.idleWakes, this.deriving);
          this.idleWakes = decided.idleWakes;
          if (decided.gaveUp) {
            console.warn(
              "Ctrl Notes: the vault closed an idle connection with work still unanswered " +
                `${decided.idleWakes} times running; waiting for the next edit or signal`,
            );
          }
          if (decided.wake) this.wake();
        },
      },
      this.syncState.cursor,
    );
    this.socket = socket;
    socket.connect();
  }

  private disconnectSyncing(): void {
    this.socket?.disconnect();
    this.socket = null;
    // A park belongs to the pair being torn down. The next connection is a fresh one — a
    // relink, or a reconnect after a refusal — and gets the rescan (VS5).
    this.unpark();
    this.watchersRan = false;
    this.readiedThisPair = false;
    // Nothing is reconnecting any more.
    this.setStatus({ retrying: null });
    this.backgroundedOnMobile = false;
    this.idleWakes = 0;
    // Before the pump, and unconditionally: an outstanding fetch holds a promise
    // `apply.ts` is awaiting inside the settle loop, and never settling it would
    // latch `syncing` exactly as an abandoned push once did.
    this.fetcher?.reset();
    this.fetcher = null;
    // `abandon()` BEFORE dropping the reference (blocker fix): a `Pump` discarded with a
    // push still outstanding left that push's promise unsettled forever, and `pushTouched`
    // awaits it directly — `this.syncing` latched `true` for the rest of this instance's
    // life and every later edit silently stopped pushing.
    // A half-received snapshot belongs to the connection that was delivering
    // it. Resuming one across a socket that died would apply a list assembled
    // from two different points in time — and a snapshot is authoritative, so
    // that list would delete whatever fell between them.
    this.pump?.forgetSnapshotPages();
    this.pump?.abandon();
    this.pump = null;
  }

  private pumpDeps(): PumpDeps {
    const transport: SyncTransport = {
      send: (up) => this.socket?.send(up),
      sendBinary: (bytes) => this.socket?.sendBinary(bytes),
      noteAck: (seq) => this.socket?.noteAck(seq),
    };
    return {
      transport,
      vault: this.vaultFiles(),
      fetchBytes: (sha) => this.fetchBytes(sha),
      ledger: () => this.syncState.hashes,
      onApplied: (applied) => this.recordApplied(applied),
      onCursor: (seq) => this.advanceCursor(seq),
      // No `onRefused` here. Every refusal answers a `pump.push` whose outcome carries it
      // to `applyPushOutcome`, which already calls `handleRefusal`; wiring this too handled
      // each refusal twice, so one refused file counted as two (found 2026-09-22 by the
      // test "counts a refused FILE without reporting the session as refused").
      //
      // The edit an inbound change left alone must reach the vault, or the
      // two versions never meet — so it joins the next settle like any save.
      onKept: (path) => {
        this.touched.dirty.add(path);
        this.settler?.touch();
      },
      // O3. `refusal` is deliberately NOT set: that field drives
      // `describeStatus`'s "Sync was refused" head, which outranks every
      // clause and stops the pending count being shown. A file the server
      // cannot send is not a refused SESSION — sync is working, and one file
      // is gone — so this contributes a clause and nothing more.
      onUnavailable: (path, reason) => {
        console.warn(`Ctrl Notes: the server has no content for ${path} (${reason})`);
        this.unavailableFiles.add(path);
        this.setStatus({ unavailable: this.unavailableFiles.size });
      },
      attachments: this.attachments,
    };
  }

  /**
   * Fetch the bytes behind a sha, over the same socket everything else uses.
   *
   * **`permanent` is the load-bearing part of the answer**, not the bytes.
   * `apply.ts` acks past a permanent miss and refuses to ack past a transient
   * one, so reporting a dead socket as permanent silently abandons content, and
   * reporting a collected blob as transient stalls the cursor forever. The
   * fetcher makes that call from the frame the vault actually sent.
   */
  /**
   * The socket URL, with this connection's routing proof.
   *
   * **The proof is the ONLY thing that gets this socket to the right vault.**
   * The control plane terminates `GET /v1/sync` and has to choose a vault app
   * before any socket exists to challenge over; a device holds a key, not a
   * bearer token, so it proves possession here instead. The vault still runs
   * its own challenge afterwards — this grants routing and nothing else.
   *
   * `vaultId` and `deviceId` come from this device's own persisted settings,
   * never from a response: rule 3, the same reason `signChallenge` takes the
   * vault id as a parameter rather than reading it off a frame.
   */
  private async syncUrl(): Promise<string> {
    const base = `${toWsUrl(this.cfg.controlplaneOrigin)}/v1/sync`;
    const proof = await this.routingProof();
    // `null` means nothing to prove with. The socket is only opened once paired, so this
    // is unreachable in practice; returning the bare URL lets the control plane refuse it
    // rather than inventing a proof that cannot verify.
    return proof === null ? base : `${base}?${proof}`;
  }

  /**
   * The `d`, `k`, `t`, `s` query that proves this device may be routed to its vault — for
   * the socket above and for the signal poll, which the control plane verifies with the same
   * function (VS8). Minted per request: it carries a 30-second freshness window.
   */
  private async routingProof(): Promise<string | null> {
    const identity = this.identity;
    const deviceId = this.cfg.deviceId;
    if (identity === null || deviceId === null) return null;
    const at = this.now();
    const signature = await identity.signRouting(deviceId, this.cfg.vaultId, at);
    return new URLSearchParams({
      d: deviceId,
      k: identity.publicKeyBase64,
      t: String(at),
      s: signature,
    }).toString();
  }

  // ---- parked: coming back when there is something to sync (vault-sleep design VS4, VS8) ----
  //
  //   an edit      a vault event the settler MAY send (an optimistic guess before the
  //                derive: each identical-content rewrite wakes once)  `noteTouched`
  //   the user     "Sync now", unconditionally                          `syncNow`
  //   the vault    the control plane's `seq`, polled every minute while parked and in view,
  //                and at once when the window regains focus or is shown again  `pollSignal`
  //   a pull       a pull owed after a conflict, on its own backoff     `attemptPull`
  //
  // Every trigger ends at `wake`. Only the timed poll's gets jitter (`WAKE_JITTER_MS`).
  //
  // **Focus polls; it does not wake.** A wake resumes the vault, and a desktop is refocused
  // every alt-tab: waking on focus kept a frequently used machine's vault awake all day with
  // nothing to sync. The poll asks the control plane, which does not resume anything, and
  // wakes only on the same answer the minute tick would.

  /** Registered at load, whatever the pairing state: each handler does nothing unless a
   * paired device is parked, and a device paired later needs them without a reload. */
  private watchForReturn(): void {
    // `checkCallback`, so the palette offers "Sync now" only to a device that has something
    // to sync with. It did nothing at all on an unpaired device, which reads as broken.
    //
    // **And to a refused one**, whose socket a terminal closing tore down: there, "Sync now"
    // is the retry the pane's "Try again" is (`retrySyncing`). A paired device with no
    // socket and no refusal is one still starting up, which has nothing to hurry.
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      checkCallback: (checking) => {
        if (!this.isPaired()) return false;
        if (this.socket === null && this.status.refusal === null) return false;
        if (!checking) this.syncNow();
        return true;
      },
    });
    this.registerDomEvent(window, "focus", () => void this.pollSignal(false));
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (this.inForeground()) void this.pollSignal(false);
      else if (Platform.isMobile) this.backgroundedOnMobile = true;
    });
    this.registerInterval(window.setInterval(() => void this.pollSignal(), SIGNAL_POLL_MS));
    this.register(() => this.cancelWakeTimer());
  }

  /** `visibilityState`, which is how a backgrounded phone or a minimised window reads. A
   * parked device out of view does not poll: nobody is looking, and its return to the
   * foreground is a trigger of its own. */
  private inForeground(): boolean {
    return activeDocument.visibilityState === "visible";
  }

  /**
   * Reconnect a parked device. Idempotent: `parked` is cleared here, so a second trigger
   * while the first is still connecting finds nothing to do, and `SyncSocket.connect` is
   * idempotent beneath it anyway.
   */
  private wake(): void {
    if (!this.active || !this.parked || this.socket === null) return;
    const socket = this.socket;
    this.unpark();
    socket.connect();
  }

  /**
   * "Sync now": what a user asks for is a connection, now. A parked device wakes; one waiting
   * out a drop's backoff skips the rest of it; one a refusal stopped starts again
   * (`retrySyncing`); one already connected or connecting says so, because a command that
   * visibly does nothing reads as broken.
   */
  private syncNow(): void {
    if (!this.active) return;
    if (this.socket === null) {
      this.retrySyncing();
      return;
    }
    if (this.parked) {
      this.wake();
      return;
    }
    if (this.socket.reconnectNow()) return;
    new Notice(ALREADY_SYNCING);
  }

  /** Leave the parked state. Says nothing about the rescan: `wake` keeps
   * `watchersRan` for the `ready` it is waiting on, `disconnectSyncing` clears it. */
  private unpark(): void {
    this.cancelWakeTimer();
    if (!this.parked) return;
    this.parked = false;
    this.setStatus({ parked: false });
  }

  private cancelWakeTimer(): void {
    if (this.wakeTimer !== null) window.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  /** A timed poll said the vault has something for this device: wake, after the jitter. */
  private wakeSoon(): void {
    if (this.wakeTimer !== null) return;
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      this.wake();
    }, this.random() * WAKE_JITTER_MS);
  }

  /**
   * Ask the control plane for this vault's latest `seq` (`GET /v1/sync/signal`, VS8).
   *
   * **A failure of any kind wakes nothing.** A refused proof, a 5xx or a transport error
   * says nothing about whether the vault changed, and waking on one would resume the vault
   * on every hiccup. The device keeps its other triggers.
   *
   * Every result checks `this.active` and `this.parked` first: `requestUrl` has no abort,
   * so an answer can land after unload, or after an edit has already woken the device.
   *
   * @param jitter Whether a wake waits out `WAKE_JITTER_MS`. The minute tick's does: every
   * parked device of a vault sees the same `seq` at about the same time. A poll the user set
   * off by coming back to the window does not, because one person is waiting on it.
   */
  private async pollSignal(jitter = true): Promise<void> {
    if (!this.active || !this.parked || this.polling || !this.inForeground()) return;
    this.polling = true;
    try {
      const proof = await this.routingProof();
      if (proof === null || !this.active || !this.parked) return;
      // Bounded: a poll that never settles counts as a failure — no wake — and clears
      // `polling` below.
      const got = await this.boundedRequest(
        this.cfg.controlplaneOrigin,
        `/v1/sync/signal?${proof}`,
      );
      if (!this.active || !this.parked) return;
      if (!got.ok || got.value.status !== 200) return;
      const seq = readSignal(got.value.body);
      if (seq === undefined) return;
      const decided = decideSignalWake(seq, this.syncState.cursor, this.signalMemory);
      this.signalMemory = decided.memory;
      if (decided.wake) {
        if (jitter) this.wakeSoon();
        else this.wake();
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * A control-plane GET bounded by `SIGNAL_TIMEOUT_MS`: one that never settles answers
   * `timeout`. The orphaned request may still answer later; nothing awaits it, so its result
   * is discarded. Shared by the signal poll and the settings pane's overview.
   */
  private async boundedRequest(origin: string, path: string): Promise<Requested> {
    let timer: number | undefined;
    const got = await Promise.race([
      request(origin, path, "GET"),
      new Promise<Requested>((resolve) => {
        timer = window.setTimeout(
          () => resolve({ ok: false, reason: "timeout" }),
          SIGNAL_TIMEOUT_MS,
        );
      }),
    ]);
    window.clearTimeout(timer);
    return got;
  }

  /** A vault event added to `touched`. The settle is armed as always; a parked device also
   * reconnects NOW, so the wake overlaps the settle's quiet window instead of following it
   * (VS4). */
  private noteTouched(): void {
    this.settler?.touch();
    if (this.parked && hasSomethingToSend(this.touched, this.attachments)) this.wake();
  }

  private async fetchBytes(
    sha: string,
  ): Promise<{ ok: true; value: Uint8Array } | { ok: false; code: string; permanent?: boolean }> {
    const fetcher = this.fetcher;
    if (fetcher === null) return { ok: false, code: "no_connection", permanent: false };
    const got = await fetcher.want(sha);
    return got.ok
      ? { ok: true, value: got.bytes }
      : { ok: false, code: got.reason, permanent: got.permanent };
  }

  private advanceCursor(seq: number): void {
    if (seq <= this.syncState.cursor) return;
    this.syncState = { ...this.syncState, cursor: seq };
    this.persistSyncState();
    this.setStatus({ syncedCursor: seq });
  }

  private persistSyncState(): void {
    if (this.cfg.vaultId === "") return;
    saveSyncState(this.app, this.cfg.vaultId, this.syncState);
  }

  private handleRefusal(refused: DownRefused): void {
    const plan = planRetry([refused]);
    for (const r of plan.redirty) {
      // `retry.ts`'s own contract: correct the ledger to what the vault reports as
      // current, and mark the path dirty for the NEXT settle to re-derive and re-push —
      // never a fabricated wire frame built here.
      const hashes = { ...this.syncState.hashes, [r.path]: r.currentSha };
      this.syncState = { ...this.syncState, hashes };
      this.persistSyncState();
      this.touched.dirty.add(r.path);
      this.settler?.touch();
    }
    for (const r of plan.report) {
      console.warn(`Ctrl Notes: ${r.path} was refused and will not be retried: ${r.reason}`);
      this.refusedFiles.set(r.path, r.reason);
      // Not `refusal`, for the reason `onUnavailable` gives (O3): one refused FILE is not a
      // refused session. Setting it put "Sync was refused: <reason>" at the head of the
      // pane — which outranks every clause, the refused count included — with nothing to
      // clear it, so one bad file read as sync being down until a reload.
      this.setStatus({ refused: this.refusedFiles.size });
    }
  }

  // ---- watch the vault, settle, derive, push ----

  private watchVault(): void {
    const settler = new Settler(() => void this.pushTouched());
    this.settler = settler;
    this.register(() => settler.cancel());

    // Inside `onLayoutReady`, not here: Obsidian fires `create` for every existing file
    // WHILE THE VAULT LOADS, and registering in `onload` would mark an entire vault dirty
    // on every single launch (an earlier prototype's finding, unchanged by the transport rewrite).
    this.app.workspace.onLayoutReady(() => {
      this.reindexSpellings();
      // Catches an edit the watcher could never have seen — one made while this
      // device was not running at all, or a relink (`reconcile.ts`'s own doc comment named
      // this gap and left it for "a later task's job"). Vault listing is stable and complete
      // by `onLayoutReady`, which is also why the live listeners below wait for it.
      if (this.isPaired()) {
        this.startReconcile();
      }
      const vault = this.app.vault;
      this.registerEvent(
        vault.on("create", (f: TAbstractFile) => {
          this.noteSpelling(f.path);
          this.touched.dirty.add(toWirePath(f.path));
          this.noteTouched();
        }),
      );
      this.registerEvent(
        vault.on("modify", (f: TAbstractFile) => {
          this.touched.dirty.add(toWirePath(f.path));
          this.noteTouched();
        }),
      );
      this.registerEvent(
        vault.on("delete", (f: TAbstractFile) => {
          const wire = toWirePath(f.path);
          this.forgetSpelling(f.path);
          this.touched.deleted.add(wire);
          this.touched.dirty.delete(wire);
          this.noteTouched();
        }),
      );
      this.registerEvent(
        vault.on("rename", (f: TAbstractFile, oldPath: string) => {
          this.forgetSpelling(oldPath);
          this.noteSpelling(f.path);
          this.touched.renamed.set(toWirePath(f.path), toWirePath(oldPath));
          this.touched.dirty.add(toWirePath(f.path));
          this.noteTouched();
        }),
      );
    });
  }

  /**
   * One settle's worth of work: derive, send, obey. The touched set is taken and cleared
   * BEFORE any await, so an edit landing mid-push joins the next window rather than being
   * lost between the two.
   *
   * **Never pushes to a connection that has not completed its handshake.** `SyncSocket`
   * throws if asked to send before `ready` — Pump's own queue does not guard against that
   * itself, and a push attempted here before then would poison the queue for nothing.
   * Left untouched, `touched` is retried once `onFrame`'s `"ready"` handling calls
   * `settler.touch()` — clearing it here and losing the edit is the one thing this
   * function must never do.
   */
  private async pushTouched(): Promise<void> {
    if (!this.isPaired() || this.pump === null || this.socket === null || !this.socket.isReady) {
      // Nothing to send on. A parked device with something to send reconnects: the vault
      // events already did, and this catches a window re-armed any other way.
      if (this.parked && hasSomethingToSend(this.touched, this.attachments)) this.wake();
      return;
    }
    if (this.syncing) {
      this.settler?.touch(); // A push is already in flight; re-arm rather than interleave.
      return;
    }

    const touched = this.touched;
    this.touched = emptyTouched();
    this.syncing = true;
    this.deriving = true;
    try {
      const { changes, oversize, undecodable } = await deriveChanges(
        this.readableFiles(),
        this.syncState.hashes,
        touched,
        { attachments: this.attachments },
      );
      this.deriving = false;
      if (oversize.length > 0) {
        console.warn(
          `Ctrl Notes: not syncing ${oversize.length} file(s) over the size limit: ` +
            oversize.slice(0, 5).join(", "),
        );
      }
      // Its own sentence, and it names the fix. "Over the size limit" and "not text"
      // are different problems with different answers — one is the wire's cap, the other
      // is a file this device would be pushing as something it is not — and the whole
      // reason `deriveChanges` returns them separately is so the user is not told the
      // wrong one. Saying nothing is what this used to do, by sending it and letting the
      // vault refuse it on every reconnect (`sync/safe-path.ts`'s `decodesAsText`).
      if (undecodable.length > 0) {
        console.warn(
          `Ctrl Notes: not syncing ${undecodable.length} file(s) whose content is not ` +
            "UTF-8 text. Re-save them as UTF-8 to sync them: " +
            undecodable.slice(0, 5).join(", "),
        );
      }
      // **The withheld files reach the pane, not just the console.** Both
      // warnings above are `console.warn` and nothing else, while `status.ts` documents
      // `unsyncable` as "Files this device will not carry" and `describeStatus` renders
      // exactly the sentence these belong in. A user whose `notes.txt` was re-saved as
      // UTF-16 got one line in a console they will never open and a pane reading "Up to
      // date" with nothing skipped — which is the same silence the whole content gate
      // exists to break, moved one layer up.
      //
      // Every path this settle looked at is dropped before this settle's answer is added,
      // so a file that has been fixed (re-saved as UTF-8, trimmed under the frame limit) or
      // deleted stops being counted the moment the next derive sees it.
      for (const path of touched.dirty) this.withheld.delete(path);
      for (const path of touched.deleted) this.withheld.delete(path);
      for (const path of oversize) this.withheld.set(path, "oversize");
      for (const path of undecodable) this.withheld.set(path, "undecodable");
      this.setStatus({
        pending: changes.length,
        unsyncable: this.shadowed.length + this.withheld.size,
      });

      const pump = this.pump;
      if (pump === null || this.socket?.isReady !== true) {
        // Disconnected (unpair, a terminal closing, or unload): these changes were derived
        // from `touched` but never sent, and losing them would drop the whole settle.
        //
        // **Or not ready yet**, checked here because the derive awaits: an idle close that
        // landed mid-derive has woken the device, and its reconnect may still be handshaking.
        // Handing the changes back lets `ready`'s `settler.touch()` send them once.
        this.redirtyRemaining(changes);
      } else {
        // All queued at once, so the pump can batch them (BI5). **Each outcome applies the
        // moment its own answer lands**: applied later, a push's ledger write would overwrite
        // inbound events for the same path. A dropped connection keeps the pump's queue for
        // `resume()`; an abandoned pump rejects, and a rejection is redirtied below.
        let left = changes.length;
        const failed: Change[] = [];
        const settled = pump.pushAll(changes).map((sent, i) => {
          const change = changes[i] as Change;
          return sent
            .then(
              (outcome) => {
                try {
                  this.applyPushOutcome(outcome);
                } catch (e) {
                  console.warn(
                    `Ctrl Notes: ${change.path} reached the vault, but recording its answer failed`,
                    e,
                  );
                  failed.push(change);
                }
              },
              (e: unknown) => {
                console.warn(`Ctrl Notes: could not send ${change.path}`, e);
                failed.push(change);
              },
            )
            .finally(() => {
              left--;
              this.setStatus({ pending: left });
            });
        });
        await Promise.all(settled);
        // Retried on the next settle, not lost.
        this.redirtyRemaining(failed);
      }
      this.setStatus({ pending: 0 });
    } catch (e) {
      // `deriveChanges` itself can reject (a stat/read/readBinary rejection
      // it could not itself catch and skip, or a bug) — this used to escape `pushTouched`
      // uncaught, with `touched` already replaced by an empty one above, so every path in
      // this settle's window was lost for good rather than only whichever one caused it.
      console.warn("Ctrl Notes: could not derive this settle's changes", e);
      this.mergeTouched(touched);
      this.settler?.touch(); // Retry the whole window rather than losing it.
    } finally {
      this.syncing = false;
      this.deriving = false;
      // A change derived after the idle close parked this device, that then failed to send,
      // is back on `touched` with no trigger left to carry it: wake for it now.
      if (this.parked && hasSomethingToSend(this.touched, this.attachments)) this.wake();
    }
  }

  /**
   * Put derived changes this settle window could not send back onto `this.touched`, so the
   * next settle re-derives and re-sends them rather than losing them for good.
   *
   * A `Change` already carries the disk state's own verdict on what kind of edit this was —
   * re-deriving it from `touched` alone (rather than re-sending the stale `Change` object
   * directly) means the NEXT settle looks at disk again and reflects anything that changed
   * in the meantime, exactly like an ordinary vault-event-driven dirty mark would.
   */
  /**
   * Fold a whole captured `Touched` snapshot back into the CURRENT `this.touched` — additive,
   * never a replace, because a vault event may already have added something new to
   * `this.touched` during the `await` this recovers from.
   */
  private mergeTouched(extra: Touched): void {
    for (const path of extra.dirty) this.touched.dirty.add(path);
    for (const path of extra.deleted) this.touched.deleted.add(path);
    for (const [to, from] of extra.renamed) this.touched.renamed.set(to, from);
  }

  private redirtyRemaining(changes: readonly Change[]): void {
    for (const change of changes) {
      if (change.op === "delete") {
        this.touched.deleted.add(change.path);
      } else if (change.op === "rename") {
        this.touched.renamed.set(change.path, change.from);
        this.touched.dirty.add(change.path);
      } else {
        this.touched.dirty.add(change.path);
      }
    }
  }

  private applyPushOutcome(outcome: ResultOutcome): void {
    this.idleWakes = 0; // the vault answered: whatever `decideIdleWake` was counting is over
    const hashes = { ...this.syncState.hashes, ...outcome.hashes };
    for (const forgotten of outcome.forget) delete hashes[forgotten];
    this.syncState = { ...this.syncState, hashes };
    this.persistSyncState();
    if (outcome.refused !== null) this.handleRefusal(outcome.refused);
    for (const p of outcome.pull) void this.pullVaultVersion(p);
  }

  /** Every inbound write lands in the ledger through here. */
  private recordApplied(applied: readonly Applied[]): void {
    const hashes = { ...this.syncState.hashes };
    for (const a of applied) {
      if (a.hash === null) delete hashes[a.path];
      else hashes[a.path] = a.hash;
    }
    this.syncState = { ...this.syncState, hashes };
    this.persistSyncState();
  }

  /**
   * The vault merged this device's push, or kept its own version in a
   * conflict — bring the path to what the vault holds now, unless the user
   * has edited it again since (`ResultOutcome.pull` says why this exists).
   * The merge's own event usually arrives too and lands the same bytes; this
   * does not wait on it, because a conflict at the path writes no event there.
   */
  private async pullVaultVersion(p: {
    path: string;
    pushed: string;
    vault: string;
  }): Promise<void> {
    const superseded = this.pendingPulls.get(p.path);
    if (superseded !== undefined && superseded.timer !== null) {
      window.clearTimeout(superseded.timer);
    }
    this.pendingPulls.set(p.path, { ...p, attempts: 0, timer: null });
    await this.attemptPull(p.path);
  }

  /**
   * **Retried until it lands, because nothing else will bring it back.** After
   * a conflict the vault writes no event at the path (M12 — its own version
   * stayed), so a pull that fails transiently leaves disk and ledger agreeing
   * on the device's version while the vault holds another, and the status
   * reads "up to date" (review of #168). Retried with a backoff and on every
   * reconnect; it ends when it lands, when the vault says the content is gone,
   * or when the user has edited the file again — that edit is newer than
   * both, and its own upload reconciles it.
   *
   * **A parked device wakes for it** (PL9). A conflict writes no event, so no signal will
   * ever arrive for this path, and a pull attempted over a parked socket fails as
   * `no_socket` forever while the pane reads "Up to date (idle)". The wake is bounded by
   * this function's own backoff: the attempt below still fails fast on the socket that is
   * only now reconnecting and schedules the next one, and `ready` retries it sooner.
   */
  private async attemptPull(path: string): Promise<void> {
    const p = this.pendingPulls.get(path);
    if (p === undefined) return;
    if (p.timer !== null) window.clearTimeout(p.timer);
    p.timer = null;
    if (this.parked) this.wake();
    let outcome: Awaited<ReturnType<typeof pullIfUnchanged>> | "threw";
    try {
      outcome = await pullIfUnchanged(this.vaultFiles(), p.path, p.pushed, p.vault, {
        fetchBytes: (sha) => this.fetchBytes(sha),
        onApplied: (a) => this.recordApplied([a]),
      });
    } catch (e) {
      console.warn(`Ctrl Notes: could not bring ${p.path} to the vault's version`, e);
      outcome = "threw";
    }
    // Superseded while this attempt ran: a newer push owns the entry now.
    if (this.pendingPulls.get(path) !== p) return;
    if (outcome !== null && outcome !== "threw") {
      this.pendingPulls.delete(path);
      this.idleWakes = 0; // the vault answered
      return;
    }
    p.attempts += 1;
    const delay = Math.min(PULL_RETRY_BASE_MS * 2 ** (p.attempts - 1), PULL_RETRY_MAX_MS);
    // One timer per entry: `ready` retries every pending pull, so two attempts can be
    // scheduling at once, and each leaving its own timer would double the retries per
    // reconnect.
    if (p.timer !== null) window.clearTimeout(p.timer);
    const timer = window.setTimeout(() => void this.attemptPull(path), delay);
    p.timer = timer;
    this.register(() => window.clearTimeout(timer));
  }

  /** Every pull still owed, retried now — called on each reconnect. */
  private retryPendingPulls(): void {
    for (const path of this.pendingPulls.keys()) void this.attemptPull(path);
  }

  // ---- the vault, behind the narrow interfaces `apply.ts`/`derive.ts` need ----

  /**
   * A path the sync core holds (always NFC) as the bytes the filesystem actually has.
   * Resolved component by component: a file the vault does not have yet cannot be in the
   * spelling index, which is every inbound write.
   */
  private toDiskPath(wire: string): string {
    if (this.odd.size === 0) return wire;
    const exact = this.odd.get(wire);
    if (exact !== undefined) return exact;
    const cut = wire.lastIndexOf("/");
    if (cut === -1) return wire;
    return `${this.toDiskPath(wire.slice(0, cut))}/${wire.slice(cut + 1)}`;
  }

  private reindexSpellings(): void {
    this.odd = indexOddSpellings(this.app.vault.getFiles().map((f) => f.path));
  }

  private noteSpelling(diskPath: string): void {
    const wire = toWirePath(diskPath);
    if (wire === diskPath || this.odd.has(wire)) return;
    this.odd = new Map(this.odd).set(wire, diskPath);
  }

  private forgetSpelling(diskPath: string): void {
    const wire = toWirePath(diskPath);
    if (this.odd.get(wire) !== diskPath) return;
    const next = new Map(this.odd);
    next.delete(wire);
    this.odd = next;
  }

  private listWirePaths(): readonly string[] {
    const { paths, shadowed } = foldListing(this.app.vault.getFiles().map((f) => f.path));
    this.shadowed = shadowed;
    return paths;
  }

  /**
   * `Vault` behind the narrow interfaces `apply.ts` (`VaultFiles`) and `derive.ts`
   * (`ReadableFiles`) need — ported in shape from an earlier prototype's `vaultFiles()`, which
   * already solved "write does not create parent folders" (`mkdirp`) and "an inbound path
   * may not match this filesystem's Unicode normalisation" (`toDiskPath`). Neither concern
   * is protocol-specific, so neither needed rewriting, only retargeting at our own
   * `VaultFiles` shape (no `patch`, and a `stat` method `ReadableFiles` also wants).
   *
   * @param known Directories this pass has already confirmed exist — shared across one
   * settle so a folder holding many files is stat'ed once rather than once per file.
   */
  private vaultFiles(known: Set<string> = new Set()): VaultFiles & ReadableFiles {
    const adapter = this.app.vault.adapter;
    const disk = (wire: string): string => this.toDiskPath(wire);

    const mkdirp = async (path: string): Promise<void> => {
      const parts = path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (known.has(dir)) continue;
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        // Recorded only once `mkdir` has actually returned — a torn write must not become
        // a run of them for every later file in that folder.
        known.add(dir);
      }
    };

    return {
      // **No `read`, and no `write` either.** Both of Obsidian's string accessors are
      // gone from the sync path: `adapter.read` is a non-fatal decode, and `adapter.write`
      // takes a string, which cannot express the bytes the vault addresses by. Content
      // moves in both directions as the bytes on disk (`sync/safe-path.ts`'s
      // `decodesAsText` for the read side, `sync/apply.ts`'s `fetchAndWrite` for the
      // write side — a stripped BOM is what that one cost).
      readBinary: async (wire) => {
        const path = disk(wire);
        return (await adapter.exists(path)) ? new Uint8Array(await adapter.readBinary(path)) : null;
      },
      writeBinary: async (wire, bytes) => {
        const path = disk(wire);
        await mkdirp(path);
        // `slice()` copies exactly this view's bytes — a `Uint8Array` can be a window onto a
        // larger buffer — into a buffer typed `ArrayBuffer`, which is what the adapter takes.
        await adapter.writeBinary(path, bytes.slice().buffer);
      },
      // `trashLocal`, never `remove`: a delete this device should not have applied stays
      // recoverable by the user (`apply.ts`'s own doc comment on `VaultFiles.trash`).
      trash: (wire) => adapter.trashLocal(disk(wire)),
      // Obsidian's own `sensitive` flag, passed through: `DataAdapter.exists`
      // resolves through the host filesystem, so on APFS and NTFS it answers
      // true for `foo.md` while only `Foo.md` is there unless told otherwise.
      // `VaultFiles.exists` says which callers need which answer.
      exists: (wire, caseSensitive) => adapter.exists(disk(wire), caseSensitive),
      rename: async (from, to) => {
        const target = disk(to);
        await mkdirp(target);
        await adapter.rename(disk(from), target);
      },
      // Metadata only, and it runs before any read — a device that discovers a file is
      // oversized by reading it first has already buffered the whole thing.
      stat: async (wire) => {
        const stat = await adapter.stat(disk(wire));
        return stat === null ? null : { size: stat.size };
      },
    };
  }

  private readableFiles(): ReadableFiles {
    return this.vaultFiles();
  }
}
