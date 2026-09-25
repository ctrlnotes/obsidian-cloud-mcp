import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  adoptUnstampedState,
  EMPTY_STATE,
  type LocalStore,
  loadSyncState,
  saveSyncState,
} from "./state.ts";

/** The vault a stored record describes. Every case here is about one vault. */
const VAULT = "vlt_1";

/**
 * P7, on the one failure `state.ts` names as silent data loss.
 *
 * Its own comment: "a partly-trusted cursor is the one failure that loses data silently,
 * because a cursor too high skips every change below it forever." A parser reading
 * attacker- or corruption-shaped JSON out of localStorage is exactly where generated
 * input earns its keep — the table tests covered the shapes somebody thought of.
 */

const store = (value: unknown): LocalStore => ({
  loadLocalStorage: () => value,
  saveLocalStorage: () => {},
});

/** A well-formed hash, as the wire spells it. */
const hash = fc.stringMatching(/^[0-9a-f]{64}$/);
const path = fc.stringMatching(/^[A-Za-z0-9_/-]{1,20}\.md$/);

describe("loadSyncState — invariants", () => {
  /**
   * **Total.** It is handed whatever survived in localStorage, including values no
   * version of this plugin wrote. A throw here breaks startup.
   */
  it("never throws, on anything at all", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => loadSyncState(store(value), VAULT)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  /**
   * **All or nothing.** The result is either the state that was stored or `EMPTY_STATE` —
   * never a mix, because a trusted cursor beside untrusted hashes is the partial trust
   * the module refuses.
   */
  it("returns a whole state or the empty one, never a blend", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const state = loadSyncState(store(value), VAULT);
        const isEmpty = state.cursor === 0 && Object.keys(state.hashes).length === 0;
        expect(isEmpty || (Number.isSafeInteger(state.cursor) && state.cursor >= 0)).toBe(true);
        for (const h of Object.values(state.hashes)) expect(typeof h).toBe("string");
      }),
      { numRuns: 500 },
    );
  });

  /**
   * **A cursor is never trusted past `Number.MAX_SAFE_INTEGER`**, which is the specific
   * permanent-skip the module calls out: `2 ** 53 + 2` is an integer by the looser test
   * and reading it back would skip every change below it forever.
   */
  it("refuses an unsafe or negative cursor outright", () => {
    const bad = fc.oneof(
      fc.constant(Number.MAX_VALUE),
      fc.constant(2 ** 53 + 2),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NaN),
      fc.constant(-1),
      fc.integer({ min: -1_000_000, max: -1 }),
      fc.double({ min: 0.1, max: 0.9, noNaN: true }),
    );
    fc.assert(
      fc.property(bad, (cursor) => {
        expect(loadSyncState(store({ cursor, hashes: {} }), VAULT)).toEqual(EMPTY_STATE);
      }),
      { numRuns: 200 },
    );
  });

  /** One malformed hash discards the whole map rather than the entry. */
  it("refuses the state when any hash is malformed", () => {
    fc.assert(
      fc.property(
        fc.dictionary(path, hash, { minKeys: 1, maxKeys: 5 }),
        path,
        fc.oneof(fc.constant("not-a-hash"), fc.constant(""), fc.constant("ZZZ"), fc.integer()),
        (good, badPath, badHash) => {
          const hashes: Record<string, unknown> = { ...good, [badPath]: badHash };
          expect(loadSyncState(store({ cursor: 1, hashes }), VAULT)).toEqual(EMPTY_STATE);
        },
      ),
      { numRuns: 200 },
    );
  });

  /** An array is not a hash map, however empty — `typeof [] === "object"`. */
  it("refuses an array where the hash map belongs", () => {
    expect(loadSyncState(store({ cursor: 1, hashes: [] }), VAULT)).toEqual(EMPTY_STATE);
  });

  /** Deterministic: the same stored value always reads the same way. */
  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(loadSyncState(store(value), VAULT)).toEqual(loadSyncState(store(value), VAULT));
      }),
      { numRuns: 300 },
    );
  });
});

describe("save → load", () => {
  /**
   * The round trip a real session performs every time it advances. If this loses a
   * cursor, the next reconnect re-downloads the vault; if it loses a hash, the next
   * derive sends a change the server already has.
   */
  it("restores exactly what was saved", () => {
    fc.assert(
      fc.property(fc.nat(), fc.dictionary(path, hash, { maxKeys: 8 }), (cursor, hashes) => {
        let saved: unknown;
        const roundTrip: LocalStore = {
          loadLocalStorage: () => saved,
          saveLocalStorage: (_key: string, value: unknown) => {
            // Through JSON, as localStorage really is.
            saved = JSON.parse(JSON.stringify(value));
          },
        };
        saveSyncState(roundTrip, VAULT, { cursor, hashes });
        expect(loadSyncState(roundTrip, VAULT)).toEqual({ cursor, hashes });
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The stamp, as a property rather than two examples.
   *
   * The hazard is asymmetric and that is why it is worth generating: reading a FOREIGN
   * record hands `planReconcile` a hash map that satisfies its trash guard for paths this
   * device never held, and the reconcile then moves live local files to `.trash`. Failing
   * to read our OWN record only costs a re-upload.
   */
  it("never answers for a vault other than the one it describes", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.dictionary(path, hash, { maxKeys: 8 }),
        fc.uniqueArray(fc.stringMatching(/^vlt_[a-z0-9]{1,8}$/), {
          minLength: 2,
          maxLength: 2,
        }),
        (cursor, hashes, [mine, theirs]) => {
          let saved: unknown;
          const store: LocalStore = {
            loadLocalStorage: () => saved,
            saveLocalStorage: (_k: string, v: unknown) => {
              saved = JSON.parse(JSON.stringify(v));
            },
          };
          saveSyncState(store, mine as string, { cursor, hashes });

          expect(loadSyncState(store, theirs as string)).toEqual(EMPTY_STATE);
          expect(loadSyncState(store, mine as string)).toEqual({ cursor, hashes });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("adopts an unstamped record exactly once, for whoever asks first", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.dictionary(path, hash, { maxKeys: 8 }),
        fc.uniqueArray(fc.stringMatching(/^vlt_[a-z0-9]{1,8}$/), {
          minLength: 2,
          maxLength: 2,
        }),
        (cursor, hashes, [first, second]) => {
          let saved: unknown = JSON.parse(JSON.stringify({ cursor, hashes }));
          const store: LocalStore = {
            loadLocalStorage: () => saved,
            saveLocalStorage: (_k: string, v: unknown) => {
              saved = JSON.parse(JSON.stringify(v));
            },
          };

          adoptUnstampedState(store, first as string);
          // Idempotent by construction: the record is stamped now, so a second call — for
          // any vault at all — cannot move it.
          adoptUnstampedState(store, second as string);

          expect(loadSyncState(store, first as string)).toEqual({ cursor, hashes });
          expect(loadSyncState(store, second as string)).toEqual(EMPTY_STATE);
        },
      ),
      { numRuns: 300 },
    );
  });
});
