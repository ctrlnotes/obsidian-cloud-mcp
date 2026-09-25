import type { DownApplied, DownRefused } from "../wire.ts";
import type { Change } from "./derive.ts";

/**
 * Obey the vault's verdict on one change we pushed.
 *
 * **One change at a time, whatever the frame.** Glass-1 pushed a whole batch and correlated
 * `results[i]` to `sent[i]` BY INDEX, because a rename followed by an edit inside one settle
 * window was two changes at the same path and a path-keyed map lost the rename's result. Our
 * wire answers one `Up::Put`/`Up::Delete`/`Up::Rename` with exactly one `Down::Applied` or
 * `Down::Refused`, so there is no index to get wrong. Its one batch, `put_batch` (bulk-ingest
 * design BI5), carries puts to DISTINCT paths only and is answered per path, so the pump
 * splits that answer into one verdict per change before it reaches here — the case that
 * broke Glass-1, two changes at one path, cannot be in a batch at all.
 *
 * **There is no `merged` or `conflicted` status on our wire, and that is not a gap.**
 * An earlier prototype's server handed a resolved conflict back as a distinct `ChangeResult` carrying
 * bytes the device did not have. Ours resolves a conflict server-side too
 * (`ReconcileUploadCommand`, design §9) but hands the LOSING side back as an ordinary
 * `put` event on the normal replay — design §5's "a conflict file arrives as an ordinary
 * put and needs no special case". So a push that triggers a merge still comes back as a
 * plain `Down::Applied`; the conflict copy, if any, arrives later through `applyReplay`.
 */
export interface ResultOutcome {
  /** This path's ledger entry, if the push succeeded. */
  readonly hashes: Record<string, string>;
  /** Paths that no longer exist and should leave the ledger. */
  readonly forget: readonly string[];
  /** The refusal, for `retry.ts` to classify — absent when the push succeeded. */
  readonly refused: DownRefused | null;
  /**
   * Paths the vault answered with something OTHER than what was pushed — a
   * three-way merge, or a conflict that kept the vault's version at the path
   * and put this device's in a conflict file. The disk still holds what was
   * pushed, so that is what the ledger records, and the caller brings the path
   * to the vault's version with `pullIfUnchanged`.
   *
   * **Recording the vault's sha instead was a defect of its own.** The ledger
   * then claimed a base the disk did not hold, so the next derive re-pushed
   * the device's content with the vault's sha as base — a fast-forward, over
   * the very version the merge or conflict had just preserved.
   */
  readonly pull: readonly { path: string; pushed: string; vault: string }[];
}

/**
 * `sent` is required to interpret `Applied` for a `rename`: the frame itself only names
 * the destination `path`, so the source has to come from the change that was actually
 * sent, exactly like an earlier prototype's reasoning for why `applyResults` took the batch.
 */
export const applyResult = (sent: Change, down: DownApplied | DownRefused): ResultOutcome => {
  if (down.type === "refused") {
    return { hashes: {}, forget: [], refused: down, pull: [] };
  }

  if (sent.op === "delete") {
    return { hashes: {}, forget: [sent.path], refused: null, pull: [] };
  }
  if (sent.op === "rename") {
    return { hashes: { [sent.path]: down.sha }, forget: [sent.from], refused: null, pull: [] };
  }
  if (down.sha !== "" && down.sha !== sent.hash) {
    return {
      hashes: { [sent.path]: sent.hash },
      forget: [],
      refused: null,
      pull: [{ path: sent.path, pushed: sent.hash, vault: down.sha }],
    };
  }
  return { hashes: { [sent.path]: down.sha }, forget: [], refused: null, pull: [] };
};
