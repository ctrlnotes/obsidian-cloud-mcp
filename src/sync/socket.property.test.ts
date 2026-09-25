import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_RETRY_MS, retryWait, WORK_RETRY_MAX_MS } from "./socket.ts";

/**
 * `retryWait` over every rung the backoff can reach and every jitter draw (bulk-ingest design
 * BI4). The ladder is `retryMs` doubling from 1 s to `MAX_RETRY_MS`; `r` is `Math.random()`,
 * so `[0, 1)`, with 1 included here because it is the edge a cap has to hold at.
 */
const rung = fc.integer({ min: 0, max: 9 }).map((k) => Math.min(1_000 * 2 ** k, MAX_RETRY_MS));
const draw = fc.double({ min: 0, max: 1, noNaN: true });

describe("retryWait, as a property", () => {
  it("never waits past the backoff's ceiling", () => {
    fc.assert(
      fc.property(rung, draw, fc.boolean(), (retryMs, r, hasWork) => {
        expect(retryWait(retryMs, r, hasWork)).toBeLessThanOrEqual(MAX_RETRY_MS);
      }),
      { numRuns: 500 },
    );
  });

  /** **Proven able to fail** by dropping the `hasWork` branch: rungs past 30 s exceed it. */
  it("never waits past WORK_RETRY_MAX_MS while there is work", () => {
    fc.assert(
      fc.property(rung, draw, (retryMs, r) => {
        expect(retryWait(retryMs, r, true)).toBeLessThanOrEqual(WORK_RETRY_MAX_MS);
      }),
      { numRuns: 500 },
    );
  });

  /** The jitter keeps its floor wherever the cap does not bite: connections that dropped
   * together still spread out rather than retrying in lockstep. */
  it("waits at least half the rung unless the cap is what stopped it", () => {
    fc.assert(
      fc.property(rung, draw, fc.boolean(), (retryMs, r, hasWork) => {
        const w = retryWait(retryMs, r, hasWork);
        if (w < WORK_RETRY_MAX_MS || !hasWork) expect(w).toBeGreaterThanOrEqual(retryMs / 2);
      }),
      { numRuns: 500 },
    );
  });

  it("is the ordinary jitter, unchanged, when there is no work", () => {
    fc.assert(
      fc.property(rung, draw, (retryMs, r) => {
        expect(retryWait(retryMs, r, false)).toBe(retryMs / 2 + r * (retryMs / 2));
      }),
      { numRuns: 300 },
    );
  });
});
