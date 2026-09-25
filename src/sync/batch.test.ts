import { describe, expect, it } from "vitest";
import type { DownReady } from "../wire.ts";
import { BATCH_ENTRY_MAX_BYTES, type BatchLimits, batchLimitsFrom, planBatch } from "./batch.ts";
import type { Change } from "./derive.ts";
import { PUT_CHUNK_BYTES } from "./pump.ts";

const put = (path: string, size = 10): Change => ({
  op: "put",
  path,
  base: null,
  content: new Uint8Array(size),
  hash: `sha-${path}`,
});
const del = (path: string): Change => ({ op: "delete", path, base: "b" });
const rename = (from: string, path: string): Change => ({ op: "rename", from, path, base: "b" });

const LIMITS: BatchLimits = { maxOps: 100, maxBytes: 4 * 1024 * 1024 };

const ready = (ops?: number, bytes?: number): DownReady => ({
  type: "ready",
  seq: 0,
  max_batch_ops: ops ?? 0,
  max_batch_bytes: bytes ?? 0,
});

describe("batchLimitsFrom", () => {
  it("takes what a batching vault advertises", () => {
    expect(batchLimitsFrom(ready(100, 4194304))).toEqual({ maxOps: 100, maxBytes: 4194304 });
  });

  /** A vault older than the frame: sending it a batch would stall the pump for good. */
  it("offers nothing when the vault sent no limits", () => {
    expect(batchLimitsFrom(ready())).toBeNull();
  });

  it("offers nothing for a batch of one, or of no bytes", () => {
    expect(batchLimitsFrom(ready(1, 4194304))).toBeNull();
    expect(batchLimitsFrom(ready(100, 0))).toBeNull();
  });
});

describe("planBatch", () => {
  /** One frame per entry is the wire's rule, and the pump's chunk is what makes an ordinary
   * put one frame. **Proven able to fail** by setting either constant to 512 KiB. */
  it("batches exactly what one put chunk carries", () => {
    expect(BATCH_ENTRY_MAX_BYTES).toBe(PUT_CHUNK_BYTES);
  });

  it("sends nothing for an empty queue", () => {
    expect(planBatch([], LIMITS)).toBe(0);
  });

  it("sends one at a time to a vault that does not batch", () => {
    expect(planBatch([put("a.md"), put("b.md"), put("c.md")], null)).toBe(1);
  });

  it("takes consecutive small puts together", () => {
    expect(planBatch([put("a.md"), put("b.md"), put("c.md")], LIMITS)).toBe(3);
  });

  /** G3: a steady-state edit keeps today's path, not a batch of one. */
  it("leaves a lone put as a plain put", () => {
    expect(planBatch([put("a.md")], LIMITS)).toBe(1);
  });

  it("stops at maxOps", () => {
    const queue = Array.from({ length: 250 }, (_, i) => put(`n${i}.md`));
    expect(planBatch(queue, LIMITS)).toBe(100);
  });

  it("stops before the bytes would pass maxBytes, and counts an empty file as nothing", () => {
    const limits = { maxOps: 100, maxBytes: 25 };
    expect(planBatch([put("a.md", 10), put("b.md", 10), put("c.md", 10)], limits)).toBe(2);
    expect(planBatch([put("a.md", 10), put("b.md", 15), put("c.md", 0)], limits)).toBe(3);
  });

  it("sends a put larger than one chunk alone, and ends a batch before one", () => {
    const big = put("big.png", BATCH_ENTRY_MAX_BYTES + 1);
    expect(planBatch([big, put("a.md"), put("b.md")], LIMITS)).toBe(1);
    expect(planBatch([put("a.md"), put("b.md"), big, put("c.md")], LIMITS)).toBe(2);
    expect(planBatch([put("a.md"), put("b.md", BATCH_ENTRY_MAX_BYTES)], LIMITS)).toBe(2);
  });

  it("ends a batch at a delete or a rename, and never carries one", () => {
    expect(planBatch([put("a.md"), put("b.md"), del("c.md"), put("d.md")], LIMITS)).toBe(2);
    expect(planBatch([put("a.md"), rename("x.md", "b.md"), put("c.md")], LIMITS)).toBe(1);
    expect(planBatch([del("a.md"), put("b.md"), put("c.md")], LIMITS)).toBe(1);
  });

  it("ends a batch at a path it already carries", () => {
    expect(planBatch([put("a.md"), put("b.md"), put("a.md"), put("c.md")], LIMITS)).toBe(2);
  });
});
