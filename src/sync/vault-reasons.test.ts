import { describe, expect, it, vi } from "vitest";
import { decodeDown } from "../wire.ts";
import {
  IDLE_REASON,
  isIdleClosing,
  isRestartClosing,
  SERVICE_RESTART_CLOSE_CODE,
  type SocketLike,
  SyncSocket,
  VAULT_RESTART_REASON,
} from "./socket.ts";
import { REVOKED_ELSEWHERE_REASON } from "./status.ts";

/**
 * The `Down::Closing.reason` strings — and the one close code — this plugin still reads, pinned
 * by value.
 *
 * **Whether to retry is no longer one of them** (bulk-ingest design BI1): that is the
 * `retry` field's job, and the last `describe` below pins it. What text still decides is HOW
 * to retry — a restart waits a fixed delay, an idle close parks — and which sentence tells a
 * revoked device's owner what happened. A rewording on either side fails to compile nowhere
 * and warns nowhere: a restart waits out a doubled backoff instead, an idle close becomes a
 * reconnect loop that keeps the vault awake, or a revoked device silently loses its sentence.
 *
 * **Nothing detects the vault changing one of these.** The vault's source is not in this
 * repository, and no test anywhere connects the two. What this file pins is the plugin's
 * side: exactly these strings, recognised exactly this way, so a change here is deliberate
 * and a change there has to be matched here by hand.
 */
describe("the closing reasons this plugin decides on", () => {
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
    expect(isRestartClosing(IDLE_REASON)).toBe(false);
  });

  /**
   * The string `status.ts` hangs the "revoked somewhere else" copy on. Whether it stops sync is
   * the vault's `retry: "never"`, not this text (below).
   */
  it("pins the deliberately-opaque refusal the revoked-elsewhere copy hangs on", () => {
    expect(REVOKED_ELSEWHERE_REASON).toBe("not authorised");
  });
});

/**
 * **The decision is the field** (BI1). The same reason text is terminal or retried according
 * to `retry` alone, and anything short of an explicit `never` — `later`, absent (a vault older
 * than the field), a value this build does not know — is retried.
 *
 * **Proven able to fail** by reinstating a text match (treating `not authorised` as terminal
 * whatever `retry` says): the `later` row for it goes red.
 */
describe("whether a closing is retried is decided by its retry field alone", () => {
  class Fake implements SocketLike {
    closed = false;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event?: { readonly code?: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    send(): void {}
    close(): void {
      this.closed = true;
    }
    emit(down: unknown): void {
      this.onmessage?.({ data: JSON.stringify(down) });
    }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** Whether `onClosing` was told a retry follows, for one closing frame after `ready`. */
  const willRetry = async (closing: Record<string, unknown>): Promise<boolean> => {
    const sockets: Fake[] = [];
    const seen: boolean[] = [];
    const socket = new SyncSocket(
      {
        url: async () => "wss://vault.example/v1/sync",
        vaultId: "vault-1",
        deviceId: "device-1",
        identity: { signChallenge: vi.fn(async () => "sig") },
        createSocket: () => {
          const s = new Fake();
          sockets.push(s);
          return s;
        },
        onFrame: () => {},
        onClosing: (_message, retry) => seen.push(retry),
      },
      0,
    );
    socket.connect();
    await flush();
    const t = sockets[0] as Fake;
    t.emit({ type: "challenge", wire_version: 4, challenge: "AQID" });
    await flush();
    t.emit({ type: "ready", seq: 0 });
    t.emit({ type: "closing", ...closing });
    await flush();
    socket.disconnect();
    expect(seen).toHaveLength(1);
    return seen[0] as boolean;
  };

  it.each([
    ["not authorised", "never", false],
    ["not authorised", "later", true],
    ["handshake timed out", "never", false],
    ["handshake timed out", "later", true],
    ["busy", "later", true],
    ["too many connections open for this device", "later", true],
  ])("%s with retry %s: retried is %s", async (reason, retry, expected) => {
    expect(await willRetry({ reason, retry })).toBe(expected);
  });

  it.each([
    ["absent", {}],
    ["unknown", { retry: "park" }],
    ["not a string", { retry: 7 }],
    ["null", { retry: null }],
  ])("a retry field that is %s is retried, never terminal", async (_label, extra) => {
    expect(await willRetry({ reason: "not authorised", ...extra })).toBe(true);
  });

  it("decodes only an explicit never as never", () => {
    const retry = (extra: Record<string, unknown>) => {
      const d = decodeDown({ type: "closing", reason: "r", ...extra });
      return d.type === "closing" ? d.retry : null;
    };
    expect(retry({ retry: "never" })).toBe("never");
    expect(retry({ retry: "later" })).toBe("later");
    expect(retry({})).toBe("later");
    expect(retry({ retry: "NEVER" })).toBe("later");
  });
});
