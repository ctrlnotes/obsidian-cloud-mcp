import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../product.ts";
import {
  describeStatus,
  IDLE_STATUS,
  plural,
  type SyncStatus,
  skipReasonText,
  statusBarFace,
  statusReport,
} from "./status.ts";

describe("describeStatus", () => {
  it("reports never-synced before the first exchange", () => {
    expect(describeStatus(IDLE_STATUS)).toBe("Not synced yet.");
  });

  it("reports the pending count while syncing", () => {
    expect(
      describeStatus({
        syncedCursor: 4,
        pending: 12,
        unsyncable: 0,
        refused: 0,
        unavailable: 0,
        refusal: null,
        retrying: null,
        updating: false,
        parked: false,
      }),
    ).toContain("12");
  });

  it("a refusal outranks everything else", () => {
    // `refusal` is always one of the vault's own free-text sentences on this wire
    // (`Down::Closing.reason` / `Down::Refused.reason` — neither is a closed vocabulary),
    // never a code from some other product's contract.
    expect(
      describeStatus({
        syncedCursor: 4,
        pending: 9,
        unsyncable: 3,
        refused: 0,
        unavailable: 0,
        refusal: "too far behind acknowledging; reconnect and resume from your last seq",
        retrying: null,
        updating: false,
        parked: false,
      }),
    ).toContain("too far behind acknowledging");
  });

  /** Vault-sleep design VS4: a parked device is up to date and holding no connection, which
   * is not the same thing as disconnected, and says so. */
  it("a parked device reads as up to date and idle, not disconnected", () => {
    const parked = { ...IDLE_STATUS, syncedCursor: 7, parked: true };
    expect(describeStatus(parked)).toBe("Up to date. Idle until there is something to sync.");
    expect(describeStatus({ ...parked, parked: false })).toBe("Up to date.");
  });

  it("mentions skipped files when there are any", () => {
    expect(
      describeStatus({
        syncedCursor: 4,
        pending: 0,
        unsyncable: 3,
        refused: 0,
        unavailable: 0,
        refusal: null,
        retrying: null,
        updating: false,
        parked: false,
      }),
    ).toContain("3");
  });

  // O3. The server having lost a file is a THIRD thing, and the clause exists
  // because advancing the cursor past it is right and being silent about it
  // was not: the status line said "Up to date" about a vault that had lost a
  // note, and both halves were true.
  it("names files the server can no longer send, and points off this device", () => {
    const text = describeStatus({
      syncedCursor: 9,
      pending: 0,
      unsyncable: 0,
      refused: 0,
      unavailable: 2,
      refusal: null,
      retrying: null,
      updating: false,
      parked: false,
    });
    expect(text).toContain("Up to date");
    expect(text).toContain("2 files could not be downloaded");
    expect(text).toContain("another device");
    // The fix is elsewhere, so it must not be filed under this device's own
    // choices — that clause would send the user hunting their own vault for a
    // file that is already there.
    expect(text).not.toContain("not synced by this device");
  });

  it("keeps the three counts in three clauses", () => {
    const text = describeStatus({
      syncedCursor: 9,
      pending: 0,
      unsyncable: 1,
      refused: 1,
      unavailable: 1,
      refusal: null,
      retrying: null,
      updating: false,
      parked: false,
    });
    expect(text).toContain("not synced by this device");
    expect(text).toContain("refused by the server");
    expect(text).toContain("could not be downloaded");
  });

  it("says nothing about unavailable files when there are none", () => {
    const text = describeStatus({
      syncedCursor: 4,
      pending: 0,
      unsyncable: 0,
      refused: 0,
      unavailable: 0,
      refusal: null,
      retrying: null,
      updating: false,
      parked: false,
    });
    expect(text).not.toContain("could not be downloaded");
  });

  it("says nothing about skipped files when there are none", () => {
    const text = describeStatus({
      syncedCursor: 4,
      pending: 0,
      unsyncable: 0,
      refused: 0,
      unavailable: 0,
      refusal: null,
      retrying: null,
      updating: false,
      parked: false,
    });
    expect(text).toContain("Up to date");
    expect(text).not.toContain("not synced");
  });

  it("names server-refused files, with their own reason", () => {
    // regression: the whole clause could be deleted and every test stayed green — the one
    // sentence that tells a user their file will never sync was unmeasured.
    const text = describeStatus({ ...IDLE_STATUS, syncedCursor: 4, refused: 2 });
    expect(text).toContain("2");
    expect(text).toContain("refused by the server");
    // NOT the mobile sentence. Telling a desktop user their 30 MB PDF is missing because
    // "this device carries text only" is false and points them at the wrong fix.
    expect(text).not.toContain("scripts and code");
  });

  /**
   * The clause grew the two reasons a user can actually act on, because until now the only
   * place either was reported was `console.warn`: `main.ts` printed `undecodable` and
   * `oversize` to a console nobody opens while this pane said "Up to date" with nothing
   * skipped. `status.ts` documents `unsyncable` as "Files this device will not carry" and
   * both of these are exactly that.
   *
   * **Proven able to fail** by reverting the clause to its previous wording: the sentence
   * still renders and the count is still right, so the two `toContain` calls below are the
   * only thing between a withheld file and a user who is never told which fix to apply. The
   * count assertion cannot stand in for them — it passes under that revert.
   */
  it("names the two reasons a user can do something about", () => {
    const text = describeStatus({ ...IDLE_STATUS, syncedCursor: 4, unsyncable: 2 });
    expect(text).toContain("not UTF-8 text");
    expect(text).toContain("re-save one as UTF-8");
    expect(text).toContain("8 MB");
  });

  it("keeps the two skip reasons apart when both apply", () => {
    const text = describeStatus({ ...IDLE_STATUS, syncedCursor: 4, unsyncable: 3, refused: 2 });
    expect(text).toContain("clash with another file's");
    expect(text).toContain("refused by the server");
  });

  // The clause used to list four reasons `unsyncable` never counts (they are dropped by
  // `derive.ts`'s `syncable()` in silence). Naming them told a user with a withheld .txt
  // to look for a script. Pinned out, alongside the 25 MB limit that existed nowhere.
  it("names no reason the count does not include", () => {
    const text = describeStatus({ ...IDLE_STATUS, syncedCursor: 4, unsyncable: 1, refused: 1 });
    expect(text).not.toMatch(/scripts|no extension|mobile|25 MB|not yet accepted/i);
  });

  it("says nothing about refused files when there are none", () => {
    expect(describeStatus({ ...IDLE_STATUS, syncedCursor: 4 })).not.toContain("refused");
  });

  it("names an unrecognised refusal rather than swallowing it", () => {
    expect(describeStatus({ ...IDLE_STATUS, refusal: "teapot" })).toContain("teapot");
  });

  /**
   * **Nit fix.** `refusalText` used to special-case `unauthenticated` and
   * `subscription_inactive` — two codes this wire never produces (`Down::Closing.reason`
   * and `Down::Refused.reason` are both free text, checked against every reason string
   * `apps/vault/src/http/routes/sync.rs` actually sends). Every REAL refusal therefore fell
   * through to the generic branch, pasting the vault's own sentence into a parenthetical
   * that read `Sync was refused (${code}).` — e.g. `Sync was refused (this device's trust
   * has been withdrawn).`, which is not what that sentence is. This is what a real
   * revocation now renders as: the vault's own words, not a fabricated code lookup.
   */
  it("renders the vault's own words for a real revocation, not a fabricated code lookup", () => {
    const text = describeStatus({
      ...IDLE_STATUS,
      refusal: "this device's trust has been withdrawn",
      updating: false,
      parked: false,
    });
    expect(text).toContain("this device's trust has been withdrawn");
  });
});

/**
 * Design §6.3's last sentence: the refusal branch already existed and took the terminal
 * path (the vault sends `not authorised` with `retry: "never"`), and what was missing
 * was only the copy telling the user their device was revoked somewhere else.
 *
 * **Why this needs its own words at all**, when the rule above is "render the vault's own
 * sentence": `not authorised` is the ONE reason the vault deliberately refuses to explain.
 * `apps/vault/src/http/routes/sync.rs`'s `reason_text` collapses unknown device, revoked
 * device and a signature that did not verify into one string, because distinguishing them
 * tells an attacker whether a device id exists. So on this wire it is the only refusal a
 * user cannot act on from its text — and the likeliest cause by far is the one thing they
 * did on purpose somewhere else.
 */
describe("a device revoked somewhere else", () => {
  it("explains the vault's deliberately opaque refusal", () => {
    const text = describeStatus({ ...IDLE_STATUS, refusal: "not authorised" });
    expect(text).toMatch(/device list/i);
    expect(text).toMatch(/pair this device again/i);
  });

  /**
   * The same refusal arriving during the handshake reaches here with `socket.ts`'s own
   * diagnosis prefixed — `could not connect to vault "…": not authorised` — which is the
   * form a REVOKED device actually sees, because a revoked device is refused at its next
   * reconnect rather than mid-session. A check that only matched the bare string would have
   * missed every real revocation and passed anyway.
   */
  it("explains it through the handshake wrapper too", () => {
    const text = describeStatus({
      ...IDLE_STATUS,
      refusal: 'could not connect to vault "vault-1": not authorised',
      updating: false,
      parked: false,
    });
    expect(text).toMatch(/device list/i);
    // The vault id this device signed for is the other half of the diagnosis and must
    // survive: a mismatched id presents as exactly this refusal (`socket.ts`'s header).
    expect(text).toContain("vault-1");
  });

  it("says nothing about a device list for any other refusal", () => {
    const text = describeStatus({ ...IDLE_STATUS, refusal: "unsupported wire version; speak 2" });
    expect(text).not.toMatch(/device list/i);
  });
});

describe("a vault restarting for an update", () => {
  it("says the vault is updating, ahead of a refusal left from earlier", () => {
    expect(describeStatus({ ...IDLE_STATUS, updating: true, refusal: "teapot" })).toBe(
      "Vault updating, reconnecting.",
    );
  });
});

/**
 * Bulk-ingest design BI1. A closing this device is reconnecting after on its own is a clause,
 * not a refusal: a busy vault sends one every few seconds during an import, and the pane must
 * keep saying how much is left to send the whole time.
 */
describe("a device reconnecting by itself", () => {
  it("says so after the head, and keeps the pending count on screen", () => {
    const text = describeStatus({
      ...IDLE_STATUS,
      syncedCursor: 4,
      pending: 120,
      retrying: "busy",
    });
    expect(text).toBe('Syncing: 120 changes still to send. Reconnecting: the vault said "busy".');
  });

  it("is not rendered as a refusal", () => {
    const text = describeStatus({ ...IDLE_STATUS, syncedCursor: 4, retrying: "busy" });
    expect(text).not.toContain("refused");
    expect(text.startsWith("Up to date.")).toBe(true);
  });

  /**
   * A vault older than BI1 sends no `retry`, so its "not authorised" is retried like any
   * other closing, and this clause is where its owner learns why nothing syncs. **Proven able
   * to fail** by rendering the clause without the advice: the device-list match goes red.
   */
  it("carries the revoked-elsewhere advice when the reason is the opaque refusal", () => {
    const text = describeStatus({
      ...IDLE_STATUS,
      retrying: "not authorised",
    });
    expect(text).toContain('Reconnecting: the vault said "not authorised".');
    expect(text).toMatch(/device list/i);
    expect(describeStatus({ ...IDLE_STATUS, retrying: "busy" })).not.toMatch(/device list/i);
  });

  it("a refusal still outranks it", () => {
    const text = describeStatus({ ...IDLE_STATUS, refusal: "teapot", retrying: "busy" });
    expect(text).toBe("Sync was refused: teapot.");
  });
});

/**
 * The audit's findings on the sentence itself: it read as one run-on paragraph, said
 * "file(s)", carried a cursor number nobody can use, and spoke of wires, MiB and Unicode
 * normalisation. The pane now draws a headline and one line per count.
 */
describe("the status as a headline and short lines", () => {
  const full: SyncStatus = {
    ...IDLE_STATUS,
    syncedCursor: 84,
    unsyncable: 1,
    refused: 3,
    unavailable: 1,
  };

  it("puts each count on its own line under a short headline", () => {
    const report = statusReport(full);
    expect(report.headline).toBe("Up to date.");
    expect(report.lines).toHaveLength(3);
    expect(report.warning).toBe(false);
  });

  it("uses real plurals, never file(s) or change(s)", () => {
    const text = describeStatus(full);
    expect(text).toContain("1 file is not synced");
    expect(text).toContain("3 files were refused");
    expect(text).toContain("1 file could not be downloaded");
    expect(text).not.toMatch(/\(s\)/);
    expect(describeStatus({ ...IDLE_STATUS, syncedCursor: 1, pending: 1 })).toContain(
      "1 change still to send",
    );
    expect(describeStatus({ ...IDLE_STATUS, syncedCursor: 1, pending: 12 })).toContain(
      "12 changes still to send",
    );
  });

  it("never shows the cursor number", () => {
    expect(describeStatus(full)).not.toContain("84");
  });

  it("drops the implementation words", () => {
    const text = describeStatus(full);
    expect(text).not.toMatch(/wire|MiB|Unicode|console/i);
  });

  it("plural is singular only at one", () => {
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "change")).toBe("2 changes");
  });

  it("marks a refused session as a warning, and nothing else", () => {
    expect(statusReport({ ...IDLE_STATUS, refusal: "not authorised" }).warning).toBe(true);
    expect(statusReport(full).warning).toBe(false);
    expect(statusReport({ ...IDLE_STATUS, retrying: "busy" }).warning).toBe(false);
  });

  it("puts the revocation advice on its own line", () => {
    const report = statusReport({ ...IDLE_STATUS, refusal: "not authorised" });
    expect(report.headline).toBe("Sync was refused: not authorised.");
    expect(report.lines.join(" ")).toMatch(/pair this device again/i);
  });
});

describe("the status bar", () => {
  const face = (s: Partial<SyncStatus> | null) =>
    statusBarFace(s === null ? null : { ...IDLE_STATUS, syncedCursor: 3, ...s });

  it.each([
    [null, "Not paired", "cloud-off"],
    [{}, "Synced", "check"],
    [{ pending: 4 }, "Syncing 4", "refresh-cw"],
    [{ parked: true }, "Idle", "moon"],
    [{ updating: true }, "Updating", "refresh-cw"],
    [{ retrying: "busy" }, "Reconnecting", "refresh-cw"],
    [{ refusal: "not authorised" }, "Error", "alert-triangle"],
    [{ syncedCursor: null }, "Connecting", "refresh-cw"],
  ] as const)("%o reads %s", (status, text, icon) => {
    expect(face(status).text).toBe(text);
    expect(face(status).icon).toBe(icon);
  });

  it("labels the item with the full sentence, for a screen reader and a hover", () => {
    expect(face({ pending: 2 }).label).toBe(`${PRODUCT_NAME}: Syncing: 2 changes still to send.`);
    expect(face(null).label).toMatch(/not paired/i);
  });

  /** "Updating" outranks a refusal for the same reason the pane's headline does: it is the
   * newer fact. A refusal outranks "Reconnecting", as it does in the pane. */
  it("does not say Error while the vault is restarting", () => {
    expect(face({ updating: true, refusal: "old" }).text).toBe("Updating");
    expect(face({ retrying: "busy", refusal: "old" }).text).toBe("Error");
  });
});

describe("why a file is on the list", () => {
  it("gives each kind its own reason", () => {
    expect(skipReasonText({ path: "a.md", kind: "clash" })).toMatch(/clashes/);
    expect(skipReasonText({ path: "a.png", kind: "oversize" })).toMatch(/8 MB/);
    expect(skipReasonText({ path: "a.txt", kind: "undecodable" })).toMatch(/UTF-8/);
    expect(skipReasonText({ path: "a.md", kind: "refused", detail: "too large" })).toBe(
      "Refused by the server: too large.",
    );
    expect(skipReasonText({ path: "a.md", kind: "unavailable" })).toMatch(/no longer has/);
  });
});
