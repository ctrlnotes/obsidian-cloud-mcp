import type { DownRefused } from "../wire.ts";

/**
 * What a refusal costs — **ours, not an earlier prototype's.**
 *
 * Glass-1 classified retries against a CLOSED, sixteen-member `RejectCode` enum
 * (`unknown_base`, `stale_base`, `binary_as_content`, …) because its wire's `reason`
 * WAS that enum. Ours is not: `Down::Refused.reason` (`apps/vault/src/sync/wire.rs`) is a
 * free-text sentence for a human — `apps/vault/src/http/routes/sync.rs` fills it with
 * things like `"that path already exists and needs base_sha"` — so there is no closed
 * vocabulary here to switch on. `current_sha` is the one STRUCTURED field a refusal
 * carries, and reading that same file shows exactly what it means: present, there is a
 * concrete version to reconcile against; absent, there is not.
 *
 * **This also means our retry story is far smaller than an earlier prototype's**, and that is not a
 * simplification made here — it falls out of the protocol. Their `unknown_base` needed
 * `planRetry` to rebuild a `create` from the SENT change, because the batch was the only
 * surviving copy of a rejected edit's content: an inbound change riding in on the SAME
 * response had already overwritten the path on disk by the time the batch's results were
 * dispatched. Our wire has no batch — one push gets exactly one answer, and nothing else
 * touches that path in between — so a rejected push never has its own local content
 * clobbered out from under it, and there is no rescue copy to build.
 *
 * **A routine "we both changed this" never reaches this file at all.** Reading
 * `apps/vault/src/http/routes/sync.rs`'s `apply_upload`: a stale `base_sha` triggers
 * `ReconcileUploadCommand` — the three-way merge (design §9) — INSIDE the same request,
 * and a clean merge, a fast-forward or a rule-3 conflict copy all come back as a plain
 * `Down::Applied`. `Down::Refused` with a `current_sha` therefore means the reconcile
 * ITSELF hit a second failure (a nested race, or the ancestor could not be read) — rare,
 * and worth a fresh attempt; it does not mean "someone else edited this," which the vault
 * already resolved before answering at all.
 */
export interface RetryPlan {
  /**
   * Worth trying again. `currentSha` corrects this path's ledger entry to what the vault
   * reports as current, so the ordinary settle → derive pipeline quotes a `base` the vault
   * actually holds on its next attempt — never a fabricated wire frame built here.
   */
  readonly redirty: readonly { path: string; currentSha: string }[];
  /** Nothing to reconcile against: say so and stop, rather than repeating a refusal forever. */
  readonly report: readonly { path: string; reason: string }[];
}

export const planRetry = (refusals: readonly DownRefused[]): RetryPlan => {
  const redirty: { path: string; currentSha: string }[] = [];
  const report: { path: string; reason: string }[] = [];

  for (const r of refusals) {
    if (r.current_sha !== null) redirty.push({ path: r.path, currentSha: r.current_sha });
    else report.push({ path: r.path, reason: r.reason });
  }

  return { redirty, report };
};
