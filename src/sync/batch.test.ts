import { describe, expect, it } from "vitest";
import type { DownReady } from "../wire.ts";
import { batchLimitsFrom } from "./batch.ts";

const ready = (ops?: number, bytes?: number): DownReady => ({
  type: "ready",
  seq: 0,
  max_batch_ops: ops ?? 0,
  max_batch_bytes: bytes ?? 0,
});

// `planBatch` is covered by `batch.property.test.ts`.
describe("batchLimitsFrom", () => {
  it("takes what a batching vault advertises", () => {
    expect(batchLimitsFrom(ready(100, 4194304))).toEqual({ maxOps: 100, maxBytes: 4194304 });
  });

  /** A vault older than the frame: sending it a batch would stall the pump for good. */
  it("offers nothing when the vault sent no limits", () => {
    expect(batchLimitsFrom(ready())).toBeNull();
  });
});
