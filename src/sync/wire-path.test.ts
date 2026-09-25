import { describe, expect, it } from "vitest";
import { foldListing, indexOddSpellings, toWirePath } from "./wire-path.ts";

/** `é` decomposed — `e` followed by COMBINING ACUTE ACCENT. */
const NFD = "café.md";
/** The same name composed, which is what the server stores and echoes back. */
const NFC = "café.md";

describe("toWirePath", () => {
  it("composes a decomposed name", () => {
    expect(toWirePath(NFD)).toBe(NFC);
  });

  it("leaves an ASCII path exactly as it found it", () => {
    // The property the whole change rests on: an unaffected vault must see no behaviour
    // change at all, which is only true if this is the identity on ASCII.
    for (const p of ["a.md", "Notes/b.md", "x/y/z.canvas", ""]) expect(toWirePath(p)).toBe(p);
  });

  it("does NOT fold a fullwidth solidus into a separator", () => {
    // regression: the one thing NFKC would do that NFC must not. `a／b.md` is a single
    // legal filename component; under NFKC it becomes a two-component path that escapes
    // wherever the caller believed it was writing.
    const fullwidth = "a／b.md";
    expect(toWirePath(fullwidth)).toBe(fullwidth);
    expect(toWirePath(fullwidth)).not.toContain("/");
    expect(fullwidth.normalize("NFKC")).toContain("/");
  });

  it("does NOT fold two fullwidth stops into a traversal", () => {
    const dots = "．．/x.md";
    expect(toWirePath(dots).split("/")).not.toContain("..");
    expect(dots.normalize("NFKC").split("/")).toContain("..");
  });
});

describe("indexOddSpellings", () => {
  it("is empty for a vault that spells everything in NFC", () => {
    expect(indexOddSpellings(["a.md", "Notes/b.md", NFC]).size).toBe(0);
  });

  it("maps the wire spelling back to the bytes on disk", () => {
    expect(indexOddSpellings([NFD]).get(NFC)).toBe(NFD);
  });

  it("keeps only the odd ones, so the common vault carries nothing", () => {
    const odd = indexOddSpellings(["a.md", NFD, "b.md"]);
    expect([...odd.keys()]).toEqual([NFC]);
  });

  it("steps aside entirely when the composed file is also on disk", () => {
    // Both spellings exist on a byte-exact filesystem. Writing the wire path then reaches
    // the composed file with no translation, so there is nothing to record — and
    // recording the decomposed one would send every inbound write to the wrong file.
    expect(indexOddSpellings([NFD, NFC]).has(NFC)).toBe(false);
    expect(indexOddSpellings([NFC, NFD]).has(NFC)).toBe(false);
  });

  it("resolves the same way whatever order the vault enumerates in", () => {
    // Whichever spelling Obsidian happens to list first must not decide which file we
    // write to. Both candidates are DECOMPOSED and neither equals the wire form, so the
    // `candidate < held` tie-break is the only thing deciding — which is the point: an
    // earlier version of this case used two strings that normalise to DIFFERENT wire
    // paths, so there was no collision and the tie-break was never reached at all.
    //
    // The pair is a canonical-reordering one: ogonek-then-acute and acute-then-ogonek
    // both compose to the same character. Single combining marks cannot produce this.
    const wire = "\u0105\u0301.md".normalize("NFC");
    const a = wire.normalize("NFD");
    const b = "a\u0301\u0328.md";
    expect(b.normalize("NFC")).toBe(wire);
    expect(a).not.toBe(wire);
    expect(b).not.toBe(wire);
    expect(a).not.toBe(b);

    const forward = indexOddSpellings([a, b]).get(wire);
    const backward = indexOddSpellings([b, a]).get(wire);
    expect(forward).toBe(backward);
    expect(forward).toBe(a < b ? a : b);
  });
});

describe("foldListing", () => {
  it("reports NFC and says which spelling it shadowed", () => {
    const { paths, shadowed } = foldListing([NFD, NFC, "a.md"]);
    expect([...paths].sort()).toEqual([NFC, "a.md"].sort());
    // The COMPOSED file survives, because writing the wire path is what reaches it.
    // Shadowing it instead would leave every inbound write landing on the other one.
    expect(shadowed).toEqual([NFD]);
  });

  it("shadows nothing when there is no collision", () => {
    // regression: a dedupe that reports a loser for every non-NFC path would warn on
    // every reconnect of an ordinary macOS vault, where nothing is wrong.
    expect(foldListing([NFD, "a.md"])).toEqual({ paths: [NFC, "a.md"], shadowed: [] });
  });

  it("keeps a one-entry listing one entry", () => {
    // `scanManifest`'s caller turns an empty scan into `[[]]`; a dedupe that emptied a
    // one-entry chunk would make it a non-final EMPTY range, which the server refuses
    // with `empty_range` — the whole reconnect, not just the chunk.
    expect(foldListing([NFD]).paths).toEqual([NFC]);
    expect(foldListing([]).paths).toEqual([]);
  });
});
