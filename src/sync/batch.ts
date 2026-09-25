// Which queued changes travel together as one `put_batch` (bulk-ingest design BI5).
//
// **Batching changes the unit, not the concurrency.** The pump is still single-flight: one
// frame out, one answer back, then the next. What a batch changes is how much one round trip
// carries — a first sync of 20,000 notes was 20,000 round trips, and the round trips, not the
// vault's CPU, were what bounded it (design §5). A hundred puts per frame makes it ~200.
//
// **Pure, and the pump's only batching decision.** `planBatch` looks at the head of the queue
// and says how many entries go next; `pump.ts` sends them. Everything a batch may not contain
// is decided here, so it can be tested as a property rather than through a socket.

import type { DownReady } from "../wire.ts";
import type { Change } from "./derive.ts";

/** What the vault said it accepts in one `put_batch`, from its `ready`. */
export interface BatchLimits {
  readonly maxOps: number;
  readonly maxBytes: number;
}

/**
 * The largest put that may ride in a batch: one binary frame's worth.
 *
 * **One frame per entry is the wire's rule** (`wire.ts`'s `UpPutBatch`): the vault correlates
 * binary frames with entries by position, so an entry cannot be split. This is the size the
 * pump already slices an ordinary put into (`pump.ts`'s `PUT_CHUNK_BYTES`, pinned equal by a
 * test), so anything that fits one chunk today fits one batch frame, and anything larger — an
 * image, a PDF — goes alone as today's chunked `put`.
 */
export const BATCH_ENTRY_MAX_BYTES = 256 * 1024;

/**
 * The vault's batch limits, or `null` when it offers none.
 *
 * `null` for a vault older than the frame (both fields absent, decoded as 0) and for one that
 * offers a batch of one, which is no batch at all. **Sending a `put_batch` to a vault that
 * did not advertise it would stall sync for good**: such a vault drops an unknown frame in
 * silence, and the pump would wait for an answer that never comes.
 */
export function batchLimitsFrom(ready: DownReady): BatchLimits | null {
  if (ready.max_batch_ops < 2 || ready.max_batch_bytes <= 0) return null;
  return { maxOps: ready.max_batch_ops, maxBytes: ready.max_batch_bytes };
}

/**
 * How many changes at the head of `queue` to send next: 0 for an empty queue, n ≥ 2 for a
 * `put_batch` of the first n, and 1 for the head alone as its own frame.
 *
 * The batch is the longest PREFIX of the queue in which every change is a `put` of at most
 * {@link BATCH_ENTRY_MAX_BYTES} to a path not already taken, stopping at `maxOps` entries or
 * before the content would exceed `maxBytes`.
 *
 * - **A prefix, never a pick.** The queue is in the order the device decided, and a delete or
 *   rename between two puts may be what makes the second one mean what it means. So the first
 *   change that cannot ride ends the batch, rather than being skipped over.
 * - **Distinct paths**, because the vault answers per path (`DownAppliedBatch`) and refuses a
 *   batch naming one twice.
 * - **A lone put stays a plain `put`** (n = 1, not a batch of one). A steady-state edit then
 *   takes exactly today's path, which is what G3 asks: nothing that makes a first sync fast
 *   may change steady-state sync.
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
    if (size > BATCH_ENTRY_MAX_BYTES) break;
    if (taken.has(change.path)) break;
    if (bytes + size > limits.maxBytes) break;
    taken.add(change.path);
    bytes += size;
    n++;
  }
  return n >= 2 ? n : 1;
}
