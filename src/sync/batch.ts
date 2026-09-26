// Which queued changes travel together as one `put_batch` (bulk-ingest design BI5).
//
// **Batching changes the unit, not the concurrency.** The pump is still single-flight; a batch
// changes how much one round trip carries — a first sync of 20,000 notes was 20,000 round
// trips, and those, not the vault's CPU, bounded it (design §5).
//
// **Pure, and the pump's only batching decision**, so it is tested as a property rather than
// through a socket.

import { type DownReady, PUT_CHUNK_BYTES } from "../wire.ts";
import type { Change } from "./derive.ts";

/** What the vault said it accepts in one `put_batch`, from its `ready`. */
export interface BatchLimits {
  readonly maxOps: number;
  readonly maxBytes: number;
}

/**
 * The vault's batch limits, or `null` for a vault older than the frame (fields absent, decoded
 * as 0). **Sending a `put_batch` to a vault that did not advertise it would stall sync for
 * good**: such a vault drops an unknown frame in silence, and the pump would wait for an
 * answer that never comes.
 */
export function batchLimitsFrom(ready: DownReady): BatchLimits | null {
  if (ready.max_batch_ops <= 0) return null;
  return { maxOps: ready.max_batch_ops, maxBytes: ready.max_batch_bytes };
}

/**
 * How many changes at the head of `queue` to send next: 0 for an empty queue, n ≥ 2 for a
 * `put_batch` of the first n, and 1 for the head alone as its own frame.
 *
 * The batch is the longest PREFIX of puts that each fit one frame ({@link PUT_CHUNK_BYTES}),
 * to distinct paths, within `maxOps` and `maxBytes`.
 *
 * - **A prefix, never a pick**: a delete or rename between two puts may be what gives the
 *   second its meaning, so the first change that cannot ride ends the batch.
 * - **Distinct paths**: the vault answers per path and refuses a batch naming one twice.
 * - **A lone put stays a plain `put`**, so steady-state sync is unchanged (G3).
 */
export function planBatch(queue: readonly Change[], limits: BatchLimits | null): number {
  if (queue.length === 0) return 0;
  if (limits === null) return 1;
  const taken = new Set<string>();
  let bytes = 0;
  let n = 0;
  for (const change of queue) {
    if (n >= limits.maxOps) break;
    if (change.op !== "put") break;
    const size = change.content.byteLength;
    if (size > PUT_CHUNK_BYTES) break;
    if (taken.has(change.path)) break;
    if (bytes + size > limits.maxBytes) break;
    taken.add(change.path);
    bytes += size;
    n++;
  }
  return n >= 2 ? n : 1;
}
