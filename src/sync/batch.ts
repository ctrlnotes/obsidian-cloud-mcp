// Which queued changes travel together as one `put_batch` (bulk-ingest design BI5) or one
// `delete_batch`.
//
// **Batching changes the unit, not the concurrency.** The pump is still single-flight; a batch
// changes how much one round trip carries — a first sync of 20,000 notes was 20,000 round
// trips, and those, not the vault's CPU, bounded it (design §5). Deletes were the same: one
// round trip each, about nine a second, however little the vault spent on each.
//
// **Pure, and the pump's only batching decision**, so it is tested as a property rather than
// through a socket.

import { type DownReady, MAX_DELETE_BATCH_OPS, PUT_CHUNK_BYTES } from "../wire.ts";
import type { Change } from "./derive.ts";

/** What the vault said it accepts in one batch, from its `ready`. */
export interface BatchLimits {
  /** Entries in one `put_batch`; 0 when the vault takes none. */
  readonly maxOps: number;
  readonly maxBytes: number;
  /** Entries in one `delete_batch`; 0 when the vault takes none. */
  readonly maxDeleteOps: number;
}

/**
 * The vault's batch limits, or `null` for a vault older than both frames (fields absent,
 * decoded as 0). **Sending a batch to a vault that did not advertise it would stall sync for
 * good**: such a vault drops an unknown frame in silence, and the pump would wait for an
 * answer that never comes. Each frame is gated on its own field, since a vault may offer one
 * and not the other.
 *
 * The delete limit is also capped at {@link MAX_DELETE_BATCH_OPS}: past it the vault closes
 * the connection for good, whatever it advertised.
 */
export function batchLimitsFrom(ready: DownReady): BatchLimits | null {
  const maxOps = Math.max(0, ready.max_batch_ops);
  const maxDeleteOps = Math.max(0, Math.min(ready.max_delete_batch_ops, MAX_DELETE_BATCH_OPS));
  if (maxOps === 0 && maxDeleteOps === 0) return null;
  return { maxOps, maxBytes: ready.max_batch_bytes, maxDeleteOps };
}

/**
 * How many changes at the head of `queue` to send next: 0 for an empty queue, n ≥ 2 for a
 * batch of the first n — a `put_batch` when the head is a put, a `delete_batch` when it is a
 * delete — and 1 for the head alone as its own frame.
 *
 * A put batch is the longest PREFIX of puts that each fit one frame ({@link PUT_CHUNK_BYTES}),
 * to distinct paths, within `maxOps` and `maxBytes`. A delete batch is the longest prefix of
 * deletes to distinct paths within `maxDeleteOps`.
 *
 * - **A prefix, never a pick**: a delete or rename between two puts may be what gives the
 *   second its meaning, so the first change that cannot ride ends the batch. **A batch is one
 *   kind**: a put ends a run of deletes, and a delete a run of puts.
 * - **Renames always go alone**: nothing batches them.
 * - **Distinct paths**: the vault answers per path and refuses a batch naming one twice — for
 *   a `delete_batch` by closing the connection for good.
 * - **A lone put or delete stays a plain frame**, so steady-state sync is unchanged (G3).
 */
export function planBatch(queue: readonly Change[], limits: BatchLimits | null): number {
  const head = queue[0];
  if (head === undefined) return 0;
  if (limits === null) return 1;
  const n =
    head.op === "put"
      ? putRun(queue, limits)
      : head.op === "delete"
        ? deleteRun(queue, limits.maxDeleteOps)
        : 1;
  return n >= 2 ? n : 1;
}

function putRun(queue: readonly Change[], limits: BatchLimits): number {
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
  return n;
}

function deleteRun(queue: readonly Change[], maxOps: number): number {
  const taken = new Set<string>();
  let n = 0;
  for (const change of queue) {
    if (n >= maxOps) break;
    if (change.op !== "delete") break;
    if (taken.has(change.path)) break;
    taken.add(change.path);
    n++;
  }
  return n;
}
