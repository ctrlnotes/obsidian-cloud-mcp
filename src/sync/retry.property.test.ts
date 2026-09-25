import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DownRefused } from "../wire.ts";
import { planRetry } from "./retry.ts";

/**
 * P7, on the one property that matters now that the classification is a two-way split:
 * **nothing is dropped**. A refusal that lands in neither bucket is an edit that stops
 * syncing with nothing said to the user — the same failure glass-1's much larger version
 * of this property was guarding against, on a much smaller function.
 */
const refusal: fc.Arbitrary<DownRefused> = fc.record({
  type: fc.constant("refused" as const),
  path: fc.stringMatching(/^[a-z]{1,8}\.md$/),
  reason: fc.string({ maxLength: 20 }),
  current_sha: fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), { nil: null }),
});

describe("planRetry, as a property", () => {
  it("classifies every refusal exactly once", () => {
    fc.assert(
      fc.property(fc.array(refusal, { maxLength: 12 }), (refusals) => {
        const plan = planRetry(refusals);
        expect(plan.redirty.length + plan.report.length).toBe(refusals.length);
      }),
      { numRuns: 300 },
    );
  });

  it("redirties exactly the refusals that named a current_sha, and no other", () => {
    fc.assert(
      fc.property(fc.array(refusal, { maxLength: 12 }), (refusals) => {
        const plan = planRetry(refusals);
        expect(plan.redirty.map((r) => r.path)).toEqual(
          refusals.filter((r) => r.current_sha !== null).map((r) => r.path),
        );
        expect(plan.report.map((r) => r.path)).toEqual(
          refusals.filter((r) => r.current_sha === null).map((r) => r.path),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("never invents a currentSha the refusal did not name", () => {
    fc.assert(
      fc.property(fc.array(refusal, { maxLength: 12 }), (refusals) => {
        const plan = planRetry(refusals);
        // Positionally, not by a path-keyed map: two refusals CAN name the same path (a
        // rename and a replace both refused at one path), and `planRetry` preserves input
        // order the same way glass-1's did — the nth redirty answers the nth redirtyable
        // refusal, never "whichever one this path last saw".
        const sources = refusals.filter((r) => r.current_sha !== null);
        expect(plan.redirty).toHaveLength(sources.length);
        plan.redirty.forEach((r, i) => {
          expect(r.path).toBe(sources[i]?.path);
          expect(r.currentSha).toBe(sources[i]?.current_sha);
        });
      }),
      { numRuns: 300 },
    );
  });
});
