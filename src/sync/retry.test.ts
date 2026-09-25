import { describe, expect, it } from "vitest";
import type { DownRefused } from "../wire.ts";
import { planRetry } from "./retry.ts";

const refused = (path: string, currentSha: string | null, reason = "nope"): DownRefused => ({
  type: "refused",
  path,
  reason,
  current_sha: currentSha,
});

describe("planRetry", () => {
  it("redirties a refusal that names a current_sha to reconcile against", () => {
    const plan = planRetry([refused("a.md", "b".repeat(64))]);
    expect(plan.redirty).toEqual([{ path: "a.md", currentSha: "b".repeat(64) }]);
    expect(plan.report).toEqual([]);
  });

  it("reports a refusal with nothing to reconcile against, and gives up on it", () => {
    const plan = planRetry([refused("hook.sh", null, "path_denied")]);
    expect(plan.report).toEqual([{ path: "hook.sh", reason: "path_denied" }]);
    expect(plan.redirty).toEqual([]);
  });

  it("classifies several refusals independently", () => {
    const plan = planRetry([
      refused("a.md", "c".repeat(64)),
      refused("b.md", null, "that path already exists and needs base_sha"),
      refused("c.md", "d".repeat(64)),
    ]);
    expect(plan.redirty.map((r) => r.path)).toEqual(["a.md", "c.md"]);
    expect(plan.report).toEqual([
      { path: "b.md", reason: "that path already exists and needs base_sha" },
    ]);
  });

  it("does nothing with no refusals", () => {
    expect(planRetry([])).toEqual({ redirty: [], report: [] });
  });
});
