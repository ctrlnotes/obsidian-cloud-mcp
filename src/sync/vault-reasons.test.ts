import { describe, expect, it } from "vitest";
import {
  IDLE_REASON,
  isIdleClosing,
  isRestartClosing,
  isResumableClosing,
  SERVICE_RESTART_CLOSE_CODE,
  VAULT_RESTART_REASON,
} from "./socket.ts";
import { REVOKED_ELSEWHERE_REASON } from "./status.ts";

/**
 * The `Down::Closing.reason` strings — and the one close code — this plugin makes a DECISION
 * on, pinned by value.
 *
 * **Why a pin and not a comment.** `reason` is free text: there is no code, no enum and no
 * structured field on this wire (`socket.ts` and `status.ts` both say so). Every decision
 * here is an exact string match against text the Ctrl Notes vault sends. Reword one on
 * either side and nothing fails to compile or warns: a resumable closing quietly becomes
 * terminal and stops syncing until Obsidian restarts, or a revoked device silently loses the
 * one sentence that tells its owner what happened.
 *
 * **These are the vault's exact words, as of the service's protocol when this was written.**
 * The vault's source is not in this repository, so nothing here can check that it still sends
 * them; the service pins its side of the same strings in its own tests. What this file does
 * pin is that the plugin keeps recognising exactly these, so a change here is deliberate.
 */
describe("the closing reasons this plugin decides on", () => {
  it("treats the per-device connection cap as RESUMABLE", () => {
    const reason = "too many connections open for this device";
    expect(isResumableClosing(reason)).toBe(true);
  });

  it("treats falling behind on acks as RESUMABLE", () => {
    const reason = "too far behind acknowledging; reconnect and resume from your last seq";
    expect(isResumableClosing(reason)).toBe(true);
  });

  /**
   * A restart sends `closing` with this reason and THEN closes with 1012. If the wording
   * drifts, the plugin sees an unrecognised `closing`, treats it as terminal, and never
   * reaches the 1012 — every vault update would stop sync until Obsidian restarts.
   */
  it("recognises the restart reason and the 1012 close code the vault sends on shutdown", () => {
    expect(VAULT_RESTART_REASON).toBe(
      "the vault is restarting for an update; reconnect in a few seconds",
    );
    expect(SERVICE_RESTART_CLOSE_CODE).toBe(1012);
    expect(isRestartClosing(VAULT_RESTART_REASON)).toBe(true);
  });

  /**
   * The vault closes a silent socket with this reason, then with 1000, which this plugin never
   * has to read because the frame decides first. If the wording drifts, the plugin reads an
   * idle close as terminal: a Notice for every 90 s of quiet, and no sync until Obsidian
   * restarts.
   */
  it("recognises the idle reason the vault parks a device with", () => {
    expect(IDLE_REASON).toBe("idle; reconnect when there is something to sync");
    expect(isIdleClosing(IDLE_REASON)).toBe(true);
    expect(isResumableClosing(IDLE_REASON)).toBe(false);
    expect(isRestartClosing(IDLE_REASON)).toBe(false);
  });

  /**
   * NOT resumable: a revoked device retrying forever is a device whose owner is never told
   * why it stopped. It is also the string `status.ts` hangs the "revoked somewhere else" copy
   * on.
   */
  it("treats the deliberately-opaque refusal as terminal", () => {
    expect(REVOKED_ELSEWHERE_REASON).toBe("not authorised");
    expect(isResumableClosing(REVOKED_ELSEWHERE_REASON)).toBe(false);
  });
});
