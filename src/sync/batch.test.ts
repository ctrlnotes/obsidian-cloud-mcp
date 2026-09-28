import { describe, expect, it } from "vitest";
import type { DownReady } from "../wire.ts";
import { type BatchLimits, batchLimitsFrom, planBatch } from "./batch.ts";
import type { Change } from "./derive.ts";

const ready = (ops?: number, bytes?: number, deleteOps?: number): DownReady => ({
  type: "ready",
  seq: 0,
  max_batch_ops: ops ?? 0,
  max_batch_bytes: bytes ?? 0,
  max_delete_batch_ops: deleteOps ?? 0,
});

// `planBatch` is covered as a whole by `batch.property.test.ts`; the cases below name the
// delete rules one at a time.
describe("batchLimitsFrom", () => {
  it("takes what a batching vault advertises", () => {
    expect(batchLimitsFrom(ready(100, 4194304, 100))).toEqual({
      maxOps: 100,
      maxBytes: 4194304,
      maxDeleteOps: 100,
    });
  });

  /** A vault older than the frame: sending it a batch would stall the pump for good. */
  it("offers nothing when the vault sent no limits", () => {
    expect(batchLimitsFrom(ready())).toBeNull();
  });

  /** A vault that batches puts but predates `delete_batch`: deletes stay single frames. */
  it("offers no delete batch when ready lacks max_delete_batch_ops", () => {
    expect(batchLimitsFrom(ready(100, 4194304))).toEqual({
      maxOps: 100,
      maxBytes: 4194304,
      maxDeleteOps: 0,
    });
  });

  it("offers delete batches alone when only they are advertised", () => {
    expect(batchLimitsFrom(ready(0, 0, 50))).toEqual({ maxOps: 0, maxBytes: 0, maxDeleteOps: 50 });
  });

  /** Past 100 the vault closes the connection for good, whatever it advertised.
   * **Proven able to fail** by dropping the cap: `maxDeleteOps` reads 500. */
  it("never takes more than 100 deletes, whatever the vault says", () => {
    expect(batchLimitsFrom(ready(100, 4194304, 500))?.maxDeleteOps).toBe(100);
  });
});

describe("planBatch, for deletes", () => {
  const LIMITS: BatchLimits = { maxOps: 100, maxBytes: 4194304, maxDeleteOps: 100 };
  const del = (path: string): Change => ({ op: "delete", path, base: `b-${path}` });
  const put = (path: string): Change => ({
    op: "put",
    path,
    base: null,
    content: new Uint8Array(3),
    hash: "h",
  });
  const rename = (path: string, from: string): Change => ({ op: "rename", path, from, base: "b" });
  const deletes = (n: number): Change[] => Array.from({ length: n }, (_, i) => del(`n${i}.md`));

  it("takes the whole run of deletes at the head", () => {
    expect(planBatch(deletes(7), LIMITS)).toBe(7);
  });

  /** **Proven able to fail** by dropping the `maxOps` check from the delete run: 250. */
  it("stops at the advertised limit", () => {
    expect(planBatch(deletes(250), LIMITS)).toBe(100);
    expect(planBatch(deletes(250), { ...LIMITS, maxDeleteOps: 30 })).toBe(30);
  });

  /** **Proven able to fail** by letting a put join a delete run: 4. */
  it("ends the run at a put", () => {
    expect(planBatch([del("a.md"), del("b.md"), put("c.md"), del("d.md")], LIMITS)).toBe(2);
  });

  it("ends the run at a rename, which always goes alone", () => {
    expect(planBatch([del("a.md"), del("b.md"), rename("c.md", "x.md")], LIMITS)).toBe(2);
    expect(planBatch([rename("c.md", "x.md"), del("a.md"), del("b.md")], LIMITS)).toBe(1);
  });

  it("ends a put run at a delete", () => {
    expect(planBatch([put("a.md"), put("b.md"), del("c.md"), del("d.md")], LIMITS)).toBe(2);
  });

  /** The vault closes a `delete_batch` naming a path twice, for good. **Proven able to fail**
   * by dropping the path check from the delete run: 3. */
  it("never names one path twice", () => {
    expect(planBatch([del("a.md"), del("b.md"), del("a.md")], LIMITS)).toBe(2);
  });

  /** **Proven able to fail** by ignoring `maxDeleteOps === 0`: 3. */
  it("sends single deletes to a vault that did not advertise delete_batch", () => {
    expect(planBatch(deletes(3), { ...LIMITS, maxDeleteOps: 0 })).toBe(1);
    expect(planBatch(deletes(3), null)).toBe(1);
  });

  it("sends a lone delete as a plain delete", () => {
    expect(planBatch([del("a.md"), put("b.md")], LIMITS)).toBe(1);
  });
});
