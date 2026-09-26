import { describe, expect, it } from "vitest";
import {
  decideIdleWake,
  decideSignalWake,
  FRESH_SIGNAL_MEMORY,
  hasSomethingToSend,
  MAX_IDLE_WAKES,
  readSignal,
  type SignalMemory,
} from "./park.ts";

const touched = (
  dirty: string[] = [],
  deleted: string[] = [],
  renamed: Array<[string, string]> = [],
) => ({ dirty: new Set(dirty), deleted: new Set(deleted), renamed: new Map(renamed) });

describe("a parked device wakes for an edit only if it would send it", () => {
  it("wakes for a note, a deleted note and a renamed note", () => {
    expect(hasSomethingToSend(touched(["a.md"]), true)).toBe(true);
    expect(hasSomethingToSend(touched([], ["a.md"]), true)).toBe(true);
    expect(hasSomethingToSend(touched([], [], [["b.md", "a.md"]]), true)).toBe(true);
  });

  it("does not wake for nothing, or for a path this device never carries", () => {
    expect(hasSomethingToSend(touched(), true)).toBe(false);
    // An attachment on a device that carries none (mobile, PLUGIN §5.2).
    expect(hasSomethingToSend(touched(["img.png"]), false)).toBe(false);
    expect(hasSomethingToSend(touched(["img.png"]), true)).toBe(true);
  });

  it("a rename out of what is carried still wakes: the vault must hear the note left", () => {
    expect(hasSomethingToSend(touched([], [], [["img.png", "a.md"]]), false)).toBe(true);
  });
});

describe("the signal's body", () => {
  it("reads a seq and an unknown", () => {
    expect(readSignal({ seq: 42 })).toBe(42);
    expect(readSignal({ seq: 0 })).toBe(0);
    expect(readSignal({ seq: null })).toBeNull();
  });

  it("refuses anything else rather than guessing", () => {
    for (const body of [
      null,
      "42",
      {},
      { seq: "42" },
      { seq: -1 },
      { seq: 1.5 },
      { seq: 2 ** 60 },
    ]) {
      expect(readSignal(body)).toBeUndefined();
    }
  });
});

/** Run a sequence of answers through the decision, as successive polls would. */
const run = (answers: Array<number | null>, cursor: number): boolean[] => {
  let memory: SignalMemory = FRESH_SIGNAL_MEMORY;
  return answers.map((seq) => {
    const decided = decideSignalWake(seq, cursor, memory);
    memory = decided.memory;
    return decided.wake;
  });
};

describe("a signal wakes a parked device once per thing it could learn", () => {
  it("wakes for a seq past the cursor", () => {
    expect(run([11], 10)).toEqual([true]);
  });

  it("does not wake for a seq at or behind the cursor", () => {
    expect(run([10, 9, 0], 10)).toEqual([false, false, false]);
  });

  /**
   * **The loop plan §0 item 4 names.** An event that has not worked yet holds the cursor
   * below the vault's `seq` (PL8), so the same answer arrives on every poll. Woken each time,
   * the device reconnects every minute and its vault never sleeps.
   */
  it("does not wake twice for the same seq, while the cursor stays behind it", () => {
    expect(run([11, 11, 11], 10)).toEqual([true, false, false]);
  });

  it("wakes again for a seq past the one it last woke for", () => {
    expect(run([11, 11, 12], 10)).toEqual([true, false, true]);
  });

  /** After a control-plane restart the answer is `null` until this vault next commits (VS7):
   * one wake to catch whatever the gap hid, and no more. */
  it("wakes once for a run of unknowns, not once per poll", () => {
    expect(run([null, null, null], 10)).toEqual([true, false, false]);
  });

  it("a number ends a run of unknowns, so the next run wakes once again", () => {
    expect(run([null, null, 5, null, null], 10)).toEqual([true, false, false, true, false]);
  });

  it("an unknown does not forget the seq it last woke for", () => {
    expect(run([11, null, 11], 10)).toEqual([true, true, false]);
  });
});

describe("an idle close with work outstanding re-wakes, a bounded number of times", () => {
  /** Feed a run of idle closes through the rule, as `onIdle` does. */
  const closes = (outstanding: boolean[]): boolean[] => {
    let idleWakes = 0;
    return outstanding.map((o) => {
      const decided = decideIdleWake(o, idleWakes);
      idleWakes = decided.idleWakes;
      return decided.wake;
    });
  };

  it("parks when nothing is outstanding", () => {
    expect(closes([false, false])).toEqual([false, false]);
  });

  it("re-wakes for outstanding work, and stops after MAX_IDLE_WAKES in a row", () => {
    const run = Array<boolean>(MAX_IDLE_WAKES + 2).fill(true);
    const woke = closes(run);
    expect(woke.filter(Boolean)).toHaveLength(MAX_IDLE_WAKES);
    expect(woke.slice(MAX_IDLE_WAKES)).toEqual([false, false]);
    expect(decideIdleWake(true, MAX_IDLE_WAKES).gaveUp).toBe(true);
  });

  it("a quiet close resets the count, so the next stranded push re-wakes again", () => {
    const run = [...Array<boolean>(MAX_IDLE_WAKES + 1).fill(true), false, true];
    expect(closes(run).slice(-1)).toEqual([true]);
  });

  /**
   * A first sync's derive can outlast several idle closes; parked mid-derive, the vault could
   * suspend in the middle of it (BI4). **Proven able to fail** by ignoring `deriving`: the
   * fourth close parks.
   */
  it("never parks while a derive is running, however many closes it outlasts", () => {
    let idleWakes = 0;
    for (let close = 0; close < MAX_IDLE_WAKES * 3; close++) {
      const decided = decideIdleWake(true, idleWakes, true);
      expect(decided).toMatchObject({ wake: true, gaveUp: false });
      idleWakes = decided.idleWakes;
    }
    // …and does not spend the bound, so a push the vault never answers is still bounded after.
    expect(idleWakes).toBe(0);
  });
});
