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
   * files are not being synced, and why" — and `describeStatus` answers it in one clause
   * that names every reason. Splitting the count would make the pane enumerate this
   * plugin's internals rather than the user's files.
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
 * One sentence for the settings tab.
 *
 * A refusal outranks everything: while sync is refused the pending count is not progress
 * toward anything, and showing "12 files to send" beside a dead link is a promise the
 * plugin cannot keep.
 *
 * The skipped-file clause names *when* it was measured, and it grew two reasons. It is
 * computed when this device scans or derives, never continuously, so a vault that gained
 * twenty images since load still reports the old count — labelling it is the difference
 * between stale and wrong. "As of the last reconnect" was the old label and is no longer
 * true of half the count: `main.ts` refreshes the withheld half on every settle that
 * derives, which is much more often than a reconnect.
 *
 * **The two new reasons are the ones a user can act on**, which is why they are spelled out
 * rather than folded into "not synced by this device": a file over the frame limit and a
 * file whose bytes are not UTF-8 both have a fix the user can perform, and until this
 * clause named them the only place either was reported was `console.warn`.
 */
export function describeStatus(status: SyncStatus): string {
  // Before the refusal, because it is the newer fact: a vault restart can only reach a
  // device that was connected, and a refusal still set from earlier would otherwise tell a
  // user whose sync is about to resume by itself that it was refused.
  if (status.updating) return UPDATING_TEXT;
  if (status.refusal !== null) return refusalText(status.refusal);

  const head =
    status.pending > 0
      ? `Syncing: ${status.pending} change(s) still to send.`
      : status.syncedCursor === null
        ? "Never synced."
        : `Up to date at change ${status.syncedCursor}${status.parked ? " (idle)" : ""}.`;

  const clauses: string[] = [];
  // First: it explains why the head has not moved, and the head is still true.
  if (status.retrying !== null) clauses.push(retryingText(status.retrying));
  // Names exactly what `unsyncable` COUNTS (`main.ts`: `shadowed` plus `withheld`, which
  // is oversize plus undecodable) and nothing else. Until 2026-09-22 this also listed
  // scripts, extensionless files, unsafe names and mobile attachments — which `derive.ts`
  // drops by `syncable()` without counting them — and omitted name collisions, the one
  // reason it did count that the user cannot guess.
  if (status.unsyncable > 0) {
    clauses.push(
      `${status.unsyncable} file(s) are not synced by this device ` +
        "(files larger than the 8 MiB this wire carries; .md, .canvas, .txt and .base " +
        "files whose bytes are not UTF-8 text, so re-save one as UTF-8 to sync it; and " +
        "files whose name matches another's once Unicode-normalised), as of the last time " +
        "this device looked.",
    );
  }
  // Its own clause, and its own reason. Folding it into the sentence above would tell a
  // desktop user their 30 MB PDF is missing because this device carries text only, which is
  // false and points them at the wrong fix.
  if (status.refused > 0) {
    clauses.push(
      `${status.refused} file(s) were refused by the server and will not be retried ` +
        "(the console names each one with the server's own reason).",
    );
  }
  // Its own clause for the same reason `refused` has one, pointing the
  // opposite way: the other two describe files this device holds, and the fix
  // for both is here. This one is about content the SERVER has lost, and the
  // only device that can put it back is one that still has the bytes. Folding
  // it in would send the user looking through their own vault for a file that
  // is already there.
  if (status.unavailable > 0) {
    clauses.push(
      `${status.unavailable} file(s) could not be downloaded because the server no ` +
        "longer holds their content, and it will not arrive later. If another device " +
        "still has one of these files, editing or re-saving it there uploads it again.",
    );
  }
  return clauses.length === 0 ? head : `${head} ${clauses.join(" ")}`;
}

/** What the status line says while the vault restarts for an update. Exported so a test can
 * assert the sentence rather than a fragment of it. */
export const UPDATING_TEXT = "Vault updating, reconnecting.";

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
function refusalText(reason: string): string {
  const said = `Sync was refused: ${reason}.`;
  return reason.endsWith(REVOKED_ELSEWHERE_REASON) ? `${said} ${REVOKED_ELSEWHERE_ADVICE}` : said;
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
