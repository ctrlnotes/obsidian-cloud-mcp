// @wire-source server/src/sync/path-order.ts
// @wire-end
/**
 * Path order, NORMATIVE (§3.6): UTF-8 byte order, which is what SQLite's default
 * `BINARY` collation compares and therefore what `ORDER BY path` returns.
 *
 * JavaScript's `<` compares UTF-16 code units instead, and the two disagree above
 * the BMP: a surrogate pair (`D800`–`DBFF`) sorts BELOW `E000`–`FFFF` as code
 * units while the character it encodes sorts above as bytes. An emoji in a
 * filename — routine in an Obsidian vault — then lands on different sides of a
 * chunk boundary on each side of the wire, and a path is silently skipped.
 *
 * **Compared by CODE POINT, not by encoded bytes, and the difference is not
 * cosmetic.** UTF-8 is order-preserving, so iterating code points gives byte
 * order for free — but it also gives the right answer for a LONE surrogate,
 * where encoding does not. `TextEncoder` substitutes U+FFFD for an unpaired
 * surrogate; workerd's SQLite stores it as WTF-8 (`\uD800` → `ED A0 80`, not
 * `EF BF BD`). A byte-array comparator therefore disagreed with the database in
 * sign, and reported two distinct paths as equal, on input nothing rejects —
 * `validateVaultPath` does not screen lone surrogates and JSON carries them
 * intact. `for…of` yields a lone surrogate as itself and a pair as its combined
 * code point, and those numeric values are in WTF-8 byte order already.
 *
 * regression: `manifest.test.ts` → "matches SQLite for lone surrogates".
 */
export const comparePaths = (a: string, b: string): number => {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done === true) return q.done === true ? 0 : -1;
    if (q.done === true) return 1;
    const d = p.value.codePointAt(0)! - q.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
};
