import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PUT_CHUNK_BYTES } from "../wire.ts";
import { type BatchLimits, planBatch } from "./batch.ts";
import type { Change } from "./derive.ts";

/**
 * `planBatch` over random queues (bulk-ingest design BI5). Paths come from a small alphabet so
 * that duplicates are common, and sizes straddle the one-frame limit so that both sides of it
 * appear; content is never allocated past what a size needs, since only `byteLength` is read.
 */
const path = fc.constantFrom("a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md");
const size = fc.oneof(
  fc.integer({ min: 0, max: 64 }),
  fc.constantFrom(PUT_CHUNK_BYTES, PUT_CHUNK_BYTES + 1),
);
const change: fc.Arbitrary<Change> = fc
  .oneof(
    { weight: 6, arbitrary: fc.record({ path, size }) },
    { weight: 1, arbitrary: fc.record({ path, op: fc.constantFrom("delete", "rename") }) },
  )
  .map((c): Change => {
    if ("size" in c) {
      return { op: "put", path: c.path, base: null, content: new Uint8Array(c.size), hash: "h" };
    }
    return c.op === "delete"
      ? { op: "delete", path: c.path, base: "b" }
      : { op: "rename", path: c.path, from: "z.md", base: "b" };
  });
const queue = fc.array(change, { maxLength: 30 });
const limits: fc.Arbitrary<BatchLimits> = fc.record({
  maxOps: fc.integer({ min: 2, max: 12 }),
  maxBytes: fc.integer({ min: 1, max: 2 * PUT_CHUNK_BYTES }),
});

const bytesOf = (c: Change): number => (c.op === "put" ? c.content.byteLength : 0);

/** Whether `c` may join a batch already holding `taken` — every criterion but the op count. */
const fits = (taken: readonly Change[], c: Change, l: BatchLimits): boolean =>
  c.op === "put" &&
  c.content.byteLength <= PUT_CHUNK_BYTES &&
  !taken.some((t) => t.path === c.path) &&
  taken.reduce((sum, t) => sum + bytesOf(t), 0) + c.content.byteLength <= l.maxBytes;

describe("planBatch, as a property", () => {
  it("sends something whenever there is something, and never more than there is", () => {
    fc.assert(
      fc.property(queue, fc.option(limits, { nil: null }), (q, l) => {
        const n = planBatch(q, l);
        expect(n === 0).toBe(q.length === 0);
        expect(n).toBeLessThanOrEqual(q.length);
      }),
      { numRuns: 500 },
    );
  });

  it("never batches for a vault without limits", () => {
    fc.assert(
      fc.property(queue, (q) => {
        expect(planBatch(q, null)).toBe(Math.min(q.length, 1));
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Every batch obeys the wire: at most `maxOps` entries, at most `maxBytes` of content, puts
   * only, each one frame, paths distinct. **Proven able to fail** by dropping the path check
   * from `planBatch`: a duplicate appears within a few runs.
   */
  it("a batch holds only small puts to distinct paths, within both limits", () => {
    fc.assert(
      fc.property(queue, limits, (q, l) => {
        const n = planBatch(q, l);
        if (n < 2) return;
        const batch = q.slice(0, n);
        expect(n).toBeLessThanOrEqual(l.maxOps);
        expect(batch.reduce((sum, c) => sum + bytesOf(c), 0)).toBeLessThanOrEqual(l.maxBytes);
        for (const c of batch) {
          expect(c.op).toBe("put");
          expect(bytesOf(c)).toBeLessThanOrEqual(PUT_CHUNK_BYTES);
        }
        expect(new Set(batch.map((c) => c.path)).size).toBe(n);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * Maximal: a batch stops only where it must. If it is shorter than the queue and the op
   * limit, the next change breaks a rule. And a single frame is sent only when no batch of two
   * was possible — a lone put is never promoted, and a batchable pair is never split.
   */
  it("is the longest batch the rules allow", () => {
    fc.assert(
      fc.property(queue, limits, (q, l) => {
        const n = planBatch(q, l);
        if (n >= 2) {
          const next = q[n];
          if (n < Math.min(q.length, l.maxOps) && next !== undefined) {
            expect(fits(q.slice(0, n), next, l)).toBe(false);
          }
        } else if (q.length >= 2) {
          const [first, second] = q as [Change, Change];
          expect(fits([], first, l) && fits([first], second, l)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
