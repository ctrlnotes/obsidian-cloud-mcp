import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldListing, indexOddSpellings, toWirePath } from "./wire-path.ts";

/**
 * P7: the helper is pure, so it owes properties as well as examples.
 *
 * The generator has to actually REACH decomposed input or every property below is a
 * statement about ASCII. The combining marks and the compatibility characters are drawn
 * explicitly, and the run reports what fraction of cases normalisation moved — a fuzz
 * target that quietly stops reaching its own subject is the failure mode this repo has
 * already paid for once.
 */
const arbPath = fc
  .array(
    fc.oneof(
      fc.constantFrom("a", "b", "note", "Notes", "é", "é", "ü", "ü", "가", "각"),
      // The NFKC hazards: a fullwidth solidus and a fullwidth stop. NFC must leave both
      // alone; NFKC would turn them into `/` and `.`.
      fc.constantFrom("／", "．", "①", "ﬁ"),
      fc.string({ minLength: 1, maxLength: 3 }),
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(""));

describe("toWirePath", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(arbPath, (p) => {
        expect(toWirePath(toWirePath(p))).toBe(toWirePath(p));
      }),
      { numRuns: 2_000 },
    );
  });

  it("never manufactures structure", () => {
    const seen = { total: 0, moved: 0, nfkcSensitive: 0 };
    fc.assert(
      fc.property(arbPath, (p) => {
        seen.total += 1;
        const wire = toWirePath(p);
        if (wire !== p) seen.moved += 1;
        if (p.normalize("NFKC") !== wire) seen.nfkcSensitive += 1;

        // Every separator in the output came from one in the input — the NFKC hole.
        const count = (s: string, c: string) => [...s].filter((x) => x === c).length;
        expect(count(wire, "/")).toBe(count(p, "/"));
        expect(count(wire, "\\")).toBe(count(p, "\\"));
        expect(wire.split("/").includes("..")).toBe(p.split("/").includes(".."));
        expect(wire.startsWith("/")).toBe(p.startsWith("/"));
        // Nor an empty string out of a non-empty one.
        expect(wire.length === 0).toBe(p.length === 0);
      }),
      { numRuns: 2_000 },
    );
    // Reported, not assumed. Without the combining arms this suite is about ASCII.
    expect(seen.moved / seen.total).toBeGreaterThan(0.05);
    expect(seen.nfkcSensitive / seen.total).toBeGreaterThan(0.02);
  });
});

describe("indexOddSpellings", () => {
  it("holds only paths the wire spells differently, and maps each back to itself", () => {
    fc.assert(
      fc.property(fc.array(arbPath, { maxLength: 8 }), (paths) => {
        const odd = indexOddSpellings(paths);
        for (const [wire, disk] of odd) {
          expect(toWirePath(disk)).toBe(wire);
          expect(disk).not.toBe(wire);
          // A listed path OR a directory prefix of one. Folders never appear in
          // Obsidian's `getFiles()`, and a folder is exactly what an inbound write to a
          // file the vault does not have yet needs translated.
          expect(paths.some((p) => p === disk || p.startsWith(`${disk}/`))).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("is order-independent", () => {
    fc.assert(
      fc.property(fc.array(arbPath, { maxLength: 8 }), (paths) => {
        expect([...indexOddSpellings([...paths].reverse())].sort()).toEqual(
          [...indexOddSpellings(paths)].sort(),
        );
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("foldListing", () => {
  it("reports every wire path exactly once and accounts for every input", () => {
    fc.assert(
      fc.property(fc.uniqueArray(arbPath, { maxLength: 8 }), (paths) => {
        const { paths: kept, shadowed } = foldListing(paths);
        // No duplicate can reach the server: two entries with one wire path is
        // `unsorted_entries`, which refuses every chunk of the reconnect rather than one.
        expect(new Set(kept).size).toBe(kept.length);
        expect(new Set(kept)).toEqual(new Set(paths.map(toWirePath)));
        // Nothing vanishes without being named.
        expect(kept.length + shadowed.length).toBe(paths.length);
      }),
      { numRuns: 1_000 },
    );
  });
});
