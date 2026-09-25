import { describe, expect, it } from "vitest";
import type { DownApplied, DownRefused } from "../wire.ts";
import type { Change } from "./derive.ts";
import { applyResult } from "./results.ts";

const H = (n: string) => n.repeat(64);

const put = (path: string, base: string | null, hash: string): Change => ({
  op: "put",
  path,
  base,
  content: new TextEncoder().encode("x"),
  hash,
});

describe("applyResult", () => {
  it("records the vault's sha as this path's new ledger entry", () => {
    const applied: DownApplied = { type: "applied", path: "a.md", seq: 41, sha: H("h") };
    const out = applyResult(put("a.md", null, H("h")), applied);
    expect(out).toEqual({ hashes: { "a.md": H("h") }, forget: [], refused: null, pull: [] });
  });

  /**
   * The vault answered with something other than what was pushed — a merge,
   * or a conflict that kept its own version at the path. The disk still holds
   * what was pushed, so THAT is the base; recording the vault's sha instead
   * made the next derive re-push the device's content over the version the
   * merge or conflict had just preserved.
   */
  it("records what was pushed, and asks for the vault's version, when the vault merged", () => {
    const applied: DownApplied = { type: "applied", path: "a.md", seq: 41, sha: H("s") };
    const out = applyResult(put("a.md", null, H("h")), applied);
    expect(out).toEqual({
      hashes: { "a.md": H("h") },
      forget: [],
      refused: null,
      pull: [{ path: "a.md", pushed: H("h"), vault: H("s") }],
    });
  });

  it("forgets the source of an applied rename, not only the destination", () => {
    // regression-shaped: a result names only the path it landed on. Leaving `hashes[from]`
    // behind means a later file created at that old path derives a `replace` against a
    // base the vault has not held since the move.
    const change: Change = { op: "rename", path: "new.md", from: "old.md", base: H("b") };
    const applied: DownApplied = { type: "applied", path: "new.md", seq: 41, sha: H("s") };
    const out = applyResult(change, applied);
    expect(out.hashes).toEqual({ "new.md": H("s") });
    expect(out.forget).toEqual(["old.md"]);
  });

  it("forgets an applied delete's path, and records no hash for it", () => {
    const change: Change = { op: "delete", path: "a.md", base: H("b") };
    const applied: DownApplied = { type: "applied", path: "a.md", seq: 41, sha: "" };
    const out = applyResult(change, applied);
    expect(out).toEqual({ hashes: {}, forget: ["a.md"], refused: null, pull: [] });
  });

  it("hands a refusal through untouched, for retry.ts to classify", () => {
    const refused: DownRefused = {
      type: "refused",
      path: "a.md",
      reason: "nope",
      current_sha: null,
    };
    const out = applyResult(put("a.md", H("b"), H("h")), refused);
    expect(out).toEqual({ hashes: {}, forget: [], refused, pull: [] });
  });
});
