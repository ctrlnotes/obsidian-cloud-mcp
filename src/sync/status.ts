import { PRODUCT_NAME } from "../product.ts";

/**
 * What this device would tell its user about sync — a snapshot, and the pure sentence
 * derived from it.
 *
 * Local only: everything here is already in the plugin's hands, so the settings tab needs
 * no request to render it. There is no per-device server view of what OTHER devices are
 * doing on this wire (`link_status` is an earlier prototype's concept; this protocol has nothing
 * equivalent), so this is the whole story this device can tell about itself.
 *
 * There is no timestamp in this shape, and that is deliberate rather than an omission: the
 * convention gate bans `Date` and any direct clock outside `client/src/lib/ctx.ts`, so the
 * plugin has no sanctioned wall clock to stamp one with. `syncedCursor` carries the same
 * signal honestly — null before the first successful exchange, the server's cursor after.
 */
export interface SyncStatus {
  /** The server cursor this device has applied, or null before it has ever exchanged. */
  readonly syncedCursor: number | null;
  /** Local changes seen but not yet exchanged — the `pending` the wire also reports. */
  readonly pending: number;
  /**
   * Files this device will not carry, as counted the last time it looked (stale between).
   *
   * Two sources, deliberately one number: the paths a listing folded away because another
   * file spells the same wire path, and the paths the last derive that examined them
   * withheld — too large for a frame, or bytes that are not UTF-8 (`derive.ts`'s `oversize`
   * and `undecodable`). The user's question is the same for all of them — "which of my
   * files are not being synced, and why" — and `statusReport` answers it in one line that
   * names every reason. Splitting the count would make the pane enumerate this
   * plugin's internals rather than the user's files. `main.ts` keeps the paths themselves,
   * with each one's reason, for the pane's "Show files" list.
   *
   * Distinct from {@link refused}, which is the SERVER's answer rather than this device's
   * choice.
   */
  readonly unsyncable: number;
  /**
   * Files the SERVER refused permanently — too large, or bytes that do not match their
   * address. Distinct from `unsyncable`, which is this device's own choice: these are files
   * the user asked to sync and cannot, and saying "attachments travel as bytes and this
   * device carries text only" about a 30 MB PDF on a desktop would be simply untrue.
   */
  readonly refused: number;
  /**
   * Files the server can never SEND — design O3.
   *
   * The third of three, and the three are deliberately not one number.
   * {@link unsyncable} is this device's own choice about a file it holds;
   * {@link refused} is the server rejecting something this device tried to
   * send; this is the server having no content for something this device was
   * told to fetch. A `no_blob` is permanent by construction — content is
   * addressed by its own hash, so a sha that is absent cannot later become
   * present under different bytes — so the cursor advances past it and the
   * file simply never appears.
   *
   * **That combination is why it needs a count at all.** Advancing is correct;
   * being silent while advancing meant the status line said "up to date" about
   * a vault that had lost a note, and both halves were true. The only report
   * was a `console.warn`.
   *
   * The fix it points at is not on this device, which is why it does not share
   * a clause with the other two: any device that still holds the file can
   * restore it by touching it, and no amount of waiting here will.
   */
  readonly unavailable: number;
  /**
   * The reason of the last closing that stopped sync — `retry: "never"`, a close this device
   * will not come back from on its own. Cleared by the next exchange that succeeds.
   */
  readonly refusal: string | null;
  /**
   * The reason of the last closing this device is reconnecting after on its own (BI1).
   * Cleared by the next `ready`, or when sync stops. **Not a refusal**: rendered as a clause
   * after the head, so "N change(s) still to send" stays on screen through an import.
   */
  readonly retrying: string | null;
  /**
   * The vault closed the connection because it is restarting for an update (close code 1012
   * — staged rollout design §5), and a reconnect is scheduled. Cleared by the next `ready`,
   * or by a terminal closing.
   */
  readonly updating: boolean;
  /**
   * The vault closed an idle connection and this device is holding none (vault-sleep design
   * VS4). Not "disconnected": nothing is wrong, and the device reconnects by itself the
   * moment there is something to sync. Cleared when the device starts that reconnect (`wake`,
   * via `unpark`), not when it completes: the pane stops saying "idle" as soon as the device
   * is on its way back. `ready` clears it again, for a connection that never parked.
   */
  readonly parked: boolean;
}

/**
 * Why one file is in a count above. `clash`, `oversize` and `undecodable` make up
 * `unsyncable`; `refused` and `unavailable` are their own counts.
 */
export type SkipKind = "clash" | "oversize" | "undecodable" | "refused" | "unavailable";

/**
 * One file behind a count, for the pane's "Show files" list. `detail` is the server's own
 * sentence for a `refused` file and absent otherwise.
 *
 * **Held by `main.ts` at the point it counts**, not reconstructed: every one of these paths
 * already passes through the shell on its way to a count (`shadowed` and `withheld` are sets
 * of paths; `handleRefusal` and `onUnavailable` are handed the path with the reason), so the
 * list costs a map beside each count and no new plumbing. Until then the pane said "the
 * console names each one", which is a place no user looks.
 */
export interface SkippedFile {
  readonly path: string;
  readonly kind: SkipKind;
  readonly detail?: string;
}

/** Why a file is on the list, in words. */
export function skipReasonText(file: SkippedFile): string {
  switch (file.kind) {
    case "clash":
      return "Its name clashes with another file's, so only one of them is synced.";
    case "oversize":
      return "Larger than 8 MB.";
    case "undecodable":
      return "Not UTF-8 text. Re-save it as UTF-8 to sync it.";
    case "refused":
      return file.detail === undefined
        ? "Refused by the server."
        : `Refused by the server: ${file.detail}.`;
    case "unavailable":
      return "The server no longer has its content. Re-save it on a device that still has it.";
  }
}

export const IDLE_STATUS: SyncStatus = {
  syncedCursor: null,
  pending: 0,
  unsyncable: 0,
  refused: 0,
  unavailable: 0,
  refusal: null,
  retrying: null,
  updating: false,
  parked: false,
};

/**
 * What the status says, split the way the settings pane shows it: one short headline, then
 * one short line per count. `warning` marks a refused session, so the pane can style it as
 * a warning.
 */
export interface StatusReport {
  readonly headline: string;
  readonly lines: readonly string[];
  readonly warning: boolean;
  /**
   * The refusal is the one pairing again can fix: the vault's {@link REVOKED_ELSEWHERE_REASON}
   * — and only that one. The pane offers "Pair again" on this flag and nothing else.
   *
   * **Its own flag, not `warning`.** "Pair again" erases this device's key, and until
   * 2026-09-26 it was offered beside EVERY refusal — a wire-version mismatch, a vault
   * sentence this plugin has never seen — none of which a new registration fixes. A device
   * refused for a reason that is not about its registration still has a good key, and the
   * pane's answer to that is a retry, which costs nothing.
   */
  readonly repairable: boolean;
}

/** `1 file`, `3 files`. Every count in the pane goes through this, so none says "file(s)". */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The status, for a person.
 *
 * A refusal outranks everything: while sync is refused the pending count is not progress
 * toward anything, and showing "12 changes to send" beside a dead link is a promise the
 * plugin cannot keep.
 *
 * **No implementation words.** The cursor number the headline used to carry ("Up to date at
 * change 84") is this device's position in the vault's event log, which means nothing to a
 * reader and invited the question "which change is 84?". It is still in `SyncStatus` for
 * the code that needs it; the headline says only what a person can use.
 *
 * The skipped-file line says *when* it was measured. It is computed when this device scans
 * or derives, never continuously, so a vault that gained twenty images since load still
 * reports the old count — labelling it is the difference between stale and wrong.
 *
 * **The two reasons a user can act on are spelled out** rather than folded into "not synced
 * by this device": a file over the frame limit and a file whose bytes are not UTF-8 both have
 * a fix the user can perform, and until this line named them the only place either was
 * reported was `console.warn`.
 */
export function statusReport(status: SyncStatus): StatusReport {
  // Before the refusal, because it is the newer fact: a vault restart can only reach a
  // device that was connected, and a refusal still set from earlier would otherwise tell a
  // user whose sync is about to resume by itself that it was refused.
  if (status.updating) {
    return { headline: UPDATING_TEXT, lines: [], warning: false, repairable: false };
  }
  if (status.refusal !== null) return refusalReport(status.refusal);

  const headline =
    status.pending > 0
      ? `Syncing: ${plural(status.pending, "change")} still to send.`
      : status.syncedCursor === null
        ? "Not synced yet."
        : status.parked
          ? "Up to date. Idle until there is something to sync."
          : "Up to date.";

  const lines: string[] = [];
  // First: it explains why the headline has not moved, and the headline is still true.
  if (status.retrying !== null) lines.push(retryingText(status.retrying));
  // Names exactly what `unsyncable` COUNTS (`main.ts`: `shadowed` plus `withheld`, which
  // is oversize plus undecodable) and nothing else. Until 2026-09-22 this also listed
  // scripts, extensionless files, unsafe names and mobile attachments — which `derive.ts`
  // drops by `syncable()` without counting them — and omitted name collisions, the one
  // reason it did count that the user cannot guess.
  if (status.unsyncable > 0) {
    lines.push(
      `${plural(status.unsyncable, "file")} ${status.unsyncable === 1 ? "is" : "are"} not ` +
        "synced by this device, as of its last check: larger than 8 MB, notes that are not " +
        "UTF-8 text (re-save one as UTF-8 to sync it), or names that clash with another " +
        "file's.",
    );
  }
  // Its own line, and its own reason. Folding it into the one above would tell a desktop
  // user their 30 MB PDF is missing because of something on this device, which is false and
  // points them at the wrong fix.
  if (status.refused > 0) {
    lines.push(
      `${plural(status.refused, "file")} ${status.refused === 1 ? "was" : "were"} refused by ` +
        "the server and will not be retried.",
    );
  }
  // Its own line for the same reason `refused` has one, pointing the opposite way: the
  // other two describe files this device holds, and the fix for both is here. This one is
  // about content the SERVER has lost, and the only device that can put it back is one
  // that still has the bytes.
  if (status.unavailable > 0) {
    const one = status.unavailable === 1;
    lines.push(
      `${plural(status.unavailable, "file")} could not be downloaded because the server no ` +
        `longer has ${one ? "its" : "their"} content. If another device still has ` +
        `${one ? "it" : "one of them"}, editing or re-saving it there uploads it again.`,
    );
  }
  return { headline, lines, warning: false, repairable: false };
}

/** The whole report as one string — the status bar's tooltip, and what a test can search. */
export function describeStatus(status: SyncStatus): string {
  const { headline, lines } = statusReport(status);
  return [headline, ...lines].join(" ");
}

/** What the status line says while the vault restarts for an update. Exported so a test can
 * assert the sentence rather than a fragment of it. */
export const UPDATING_TEXT = "Vault updating, reconnecting.";

/**
 * The status bar's face: an icon and ONE word, with the full sentence for a screen reader
 * and a hover. `null` is a device with no pairing, which has no `SyncStatus` worth reading —
 * an unpaired plugin holds `IDLE_STATUS`, whose "Not synced yet" would read as a device that
 * is paired and stuck.
 *
 * The icons are Lucide names, which is the set Obsidian's `setIcon` draws from.
 */
export interface StatusBarFace {
  readonly icon: string;
  readonly text: string;
  readonly label: string;
}

export function statusBarFace(status: SyncStatus | null): StatusBarFace {
  const label = (sentence: string): string => `${PRODUCT_NAME}: ${sentence}`;
  if (status === null) {
    return {
      icon: "cloud-off",
      text: "Not paired",
      label: label("this device is not paired. Open the settings to pair it."),
    };
  }
  const full = label(describeStatus(status));
  if (status.updating) return { icon: "refresh-cw", text: "Updating", label: full };
  if (status.refusal !== null) return { icon: "alert-triangle", text: "Error", label: full };
  // After the refusal, which outranks it in `statusReport` too. The pane keeps the pending
  // count beside it (a line, not the headline); one word here has room only for this.
  if (status.retrying !== null) return { icon: "refresh-cw", text: "Reconnecting", label: full };
  if (status.pending > 0) {
    return { icon: "refresh-cw", text: `Syncing ${status.pending}`, label: full };
  }
  // Before the first `ready` there is no position to report at all. "Synced" would be a
  // claim this device cannot make yet, and "Error" would be an alarm about nothing.
  if (status.syncedCursor === null) return { icon: "refresh-cw", text: "Connecting", label: full };
  if (status.parked) return { icon: "moon", text: "Idle", label: full };
  return { icon: "check", text: "Synced", label: full };
}

/**
 * `code` is never actually a code on THIS wire — `Down::Refused.reason` and
 * `Down::Closing.reason` are both free text for a human (`retry.ts`'s and `socket.ts`'s own
 * doc comments), so `main.ts` sets `refusal` straight from whichever sentence the vault
 * sent. `unauthenticated`/`subscription_inactive` were an earlier prototype's concepts this wire never
 * produces — checked: no code path here can ever set `refusal` to either string — so
 * special-casing them here rendered every REAL refusal through the fallback below anyway,
 * pasting the vault's raw sentence into a parenthetical never designed to hold one. This
 * renders that sentence directly instead of pretending there is a closed vocabulary to
 * translate it from.
 */
function refusalReport(reason: string): StatusReport {
  const headline = `Sync was refused: ${reason}.`;
  const revoked = reason.endsWith(REVOKED_ELSEWHERE_REASON);
  return {
    headline,
    lines: revoked ? [REVOKED_ELSEWHERE_ADVICE] : [],
    warning: true,
    repairable: revoked,
  };
}

/**
 * The retrying clause, quoting the vault's sentence verbatim (`socket.ts` reports a retried
 * closing without its own prefix). It carries the revoked-elsewhere advice too: a v3 vault
 * sends no `retry`, so its "not authorised" is retried (at most every five minutes) and this
 * clause is the only place its owner can learn why nothing is syncing.
 * TODO(v3): drop the advice here once no v3 vault remains.
 */
function retryingText(reason: string): string {
  const said = `Reconnecting: the vault said "${reason}".`;
  return reason.endsWith(REVOKED_ELSEWHERE_REASON) ? `${said} ${REVOKED_ELSEWHERE_ADVICE}` : said;
}

/**
 * The one refusal on this wire that the vault deliberately refuses to explain.
 *
 * `apps/vault/src/http/routes/sync.rs`'s `reason_text` collapses **unknown device, revoked
 * device and a signature that did not verify** into this single string, because
 * distinguishing them tells an attacker whether a device id exists (`pure::Reject`'s own
 * doc comment says so). Every other reason on this wire is a sentence a user can act on;
 * this one is a sentence a user cannot, which is exactly why it needs words of our own.
 *
 * **Matched by exact text, and pinned.** `Down::Closing.reason` is free text — there is no
 * code and no enum to switch on — so `vault-reasons.test.ts` reads that Rust file and holds
 * this constant against the literal in it. Reword it there without this, and a revoked
 * device silently loses the only sentence that tells its owner what happened.
 */
export const REVOKED_ELSEWHERE_REASON = "not authorised";

/**
 * Matched with `endsWith`, not equality, because a revoked device meets this refusal at its
 * next RECONNECT rather than mid-session, and `socket.ts` prefixes its own diagnosis to a
 * closing that arrives during the handshake: `could not connect to vault "…": not
 * authorised`. An equality check would have matched the rarer form and missed every real
 * revocation while looking correct.
 */
const REVOKED_ELSEWHERE_ADVICE =
  "The likeliest cause is that this device was removed from your vault's device list. " +
  "Revocation is immediate and cannot be undone, so pair this device again to reconnect. " +
  "If you did not remove it, check that this device is pointed at the vault you meant.";
