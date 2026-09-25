// A parked device's decisions (vault-sleep design VS4, VS5, VS8): when a device holding no
// connection should make one. Pure, so each rule is a table in `park.test.ts` rather than a
// property of `main.ts`'s control flow.
//
// **Why these rules are worth a module.** A wake is a `fly-replay` into the vault, and a
// suspended vault resumes for it. A parked device that wakes when it has nothing to do keeps
// its vault awake, which is the one thing parking exists to stop — and the two loops that do
// it are both quiet: they look like a device that is simply up to date.

import { syncablePath } from "./derive.ts";

/** How often a parked device asks the control plane for its vault's `seq` while Obsidian is
 * in the foreground (VS8's first step). */
export const SIGNAL_POLL_MS = 60_000;

/** The longest one signal poll may take before it counts as failed. `requestUrl` has no
 * abort, and a half-open connection (a laptop resuming on a new network, a NAT that dropped
 * the flow) can leave it pending for a very long time; a poll that never settles would latch
 * `polling` and silence every later one. Well under `SIGNAL_POLL_MS`, so the next tick finds
 * the latch clear. */
export const SIGNAL_TIMEOUT_MS = 15_000;

/**
 * The most a signal-triggered wake is delayed by. An agent's write reaches every parked
 * device of a vault at once, and they would otherwise all resume it in the same instant
 * (design §7, "many devices wake one vault at once"). Only signal wakes get it: an edit, a
 * focus or "Sync now" is one device, and a user who pressed something should not wait.
 */
export const WAKE_JITTER_MS = 2_000;

/** What `main.ts` has accumulated since its last settle — its own `Touched`, structurally. */
export interface TouchedPaths {
  readonly dirty: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
  readonly renamed: ReadonlyMap<string, string>;
}

/**
 * Whether a settle MAY hold anything this device would send (VS4's first trigger).
 *
 * **It guarantees one direction only.** A `false` means the derive would send nothing:
 * `syncablePath` is the filter `deriveChanges` applies, so a path this says no to is one the
 * derive would drop anyway, and an edit to a file this device never carries — a script, or
 * an attachment on mobile — does not resume the vault. A `true` is an optimistic guess made
 * BEFORE the derive, which is the early wake VS4 chose: the bytes are not compared with the
 * ledger, so a rewrite of identical content by an outside tool (a git checkout, a backup or
 * cloud-sync client, a plugin re-saving a note on open) wakes the vault for nothing — once
 * per rewrite, not once in all: each rewrite that lands while parked is a fresh event, and
 * the derive that would find nothing to send runs only after the wake it could have
 * spared. Comparing hashes first would cost a read of every touched file before the wake
 * VS4 moved ahead of the settle. A rename counts if either end is carried: moving a note out of sync is a delete
 * the vault must hear about.
 */
export function hasSomethingToSend(touched: TouchedPaths, attachments: boolean): boolean {
  const carried = (path: string): boolean => syncablePath(path, attachments);
  for (const path of touched.dirty) if (carried(path)) return true;
  for (const path of touched.deleted) if (carried(path)) return true;
  for (const [to, from] of touched.renamed) if (carried(to) || carried(from)) return true;
  return false;
}

/**
 * How many idle closes in a row may each reconnect at once for work still outstanding
 * (`decideIdleWake`).
 */
export const MAX_IDLE_WAKES = 3;

/**
 * Whether the vault's idle close should be answered by reconnecting at once, rather than by
 * parking (plan §6).
 *
 * `outstanding` is work the close may have stranded: a derive still running, a push the
 * vault has not answered, a `want` in flight. The close is sent without waiting for either
 * direction, so a frame that raced it is dropped, and nothing else would bring the device
 * back for it. So it reconnects, and the reconnect re-sends.
 *
 * **Bounded, because a vault that never answers makes it a loop.** Each reconnect re-sends
 * the same head, the vault stays silent for 90 s and closes again — a device that resumed
 * its vault every 90 s for good while looking like one that was merely busy. `idleWakes`
 * counts the immediate re-wakes since the last close that found nothing outstanding (or
 * since the caller saw progress and reset it); past `MAX_IDLE_WAKES` the device parks
 * anyway and says so. Its other triggers still wake it.
 */
export function decideIdleWake(
  outstanding: boolean,
  idleWakes: number,
): { readonly wake: boolean; readonly idleWakes: number; readonly gaveUp: boolean } {
  if (!outstanding) return { wake: false, idleWakes: 0, gaveUp: false };
  if (idleWakes >= MAX_IDLE_WAKES) return { wake: false, idleWakes, gaveUp: true };
  return { wake: true, idleWakes: idleWakes + 1, gaveUp: false };
}

/**
 * `GET /v1/sync/signal`'s body, `{"seq": <integer> | null}`. `undefined` for anything else —
 * a malformed answer is not a reason to wake, and not a reason to forget the last one.
 */
export function readSignal(body: unknown): number | null | undefined {
  if (typeof body !== "object" || body === null || !("seq" in body)) return undefined;
  const seq = body.seq;
  if (seq === null) return null;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

/**
 * What a parked device remembers about the signals it has acted on. Reset only when the
 * plugin loads or adopts a vault: it is a guard against looping, and a guard that forgets
 * is not one.
 */
export interface SignalMemory {
  /** The highest `seq` this device has woken for, or `null` before its first. */
  readonly wokeFor: number | null;
  /** Whether this device has already woken during the current run of `null` answers. */
  readonly wokeForUnknown: boolean;
}

export const FRESH_SIGNAL_MEMORY: SignalMemory = { wokeFor: null, wokeForUnknown: false };

/**
 * Whether one poll's answer should wake a parked device (VS8, plan §0 item 4).
 *
 * **Ahead of the cursor is necessary and not sufficient.** An event that has not worked YET
 * holds this device's cursor (PL8), so the cursor can sit below the vault's `seq` across any
 * number of reconnects. Woken on "ahead" alone, such a device would reconnect on every poll
 * and keep its vault awake for good, while looking like a device that is merely catching up.
 *
 * So a number must also be past the last one this device woke for. A reconnect is what a
 * wake buys, and one for a given `seq` is all it can use.
 *
 * **`null` is "the control plane does not know"** — it restarted, and holds nothing until
 * this vault next commits (VS7). A change may have been missed in that gap, so the first
 * `null` wakes once; the rest of the run does not, or a quiet vault would be woken every
 * minute until somebody edited something.
 */
export function decideSignalWake(
  seq: number | null,
  cursor: number,
  memory: SignalMemory,
): { readonly wake: boolean; readonly memory: SignalMemory } {
  if (seq === null) {
    return {
      wake: !memory.wokeForUnknown,
      memory: { ...memory, wokeForUnknown: true },
    };
  }
  // A number ends a run of unknowns, whatever it says.
  const known = { ...memory, wokeForUnknown: false };
  const ahead = seq > cursor && (memory.wokeFor === null || seq > memory.wokeFor);
  return ahead
    ? { wake: true, memory: { ...known, wokeFor: seq } }
    : { wake: false, memory: known };
}
