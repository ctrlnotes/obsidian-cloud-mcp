/**
 * One spelling on the wire, the vault's own bytes on disk.
 *
 * The server normalises every path to NFC and echoes the NFC spelling back
 * (`server/src/sync/vault-path.ts`). The plugin used to key `state.hashes` on whatever
 * Obsidian handed it, so for a decomposed filename the base was written under one key and
 * read under another: every edit derived as a `create`, the server answered with a
 * conflict copy, and the user's bytes were exiled beside the note while the server's older
 * bytes were written back over it. One conflict copy per save, with no state the loop
 * could reach that ended it.
 *
 * This module is plugin-native, NOT vendored — it carries no `@wire-source` stamp, because
 * a stamped file absent from the gate's `VENDORED` table is itself a violation. The server
 * has its own normalisation in `server/src/sync/vault-path.ts`; the two are allowed to be
 * written differently as long as they agree, and **nothing in this package checks that**,
 * because the plugin may not import `server/`. The differential lives on the server side,
 * in `server/src/sync/plugin-floor-nesting.fuzz.test.ts`, which is the only tier that can
 * see both.
 */

/**
 * Disk → wire. **NFC, and never NFKC.**
 *
 * The compatibility forms are the trap: NFKC maps U+FF0F FULLWIDTH SOLIDUS onto `/`, so
 * `a／b.md` — one legal filename component — would become a two-component path that
 * escapes wherever the caller thought it was writing. `server/src/sync/vault-path.ts`
 * makes the same choice for the same reason, and the property suite pins it.
 */
export const toWirePath = (path: string): string => path.normalize("NFC");

/**
 * Which disk spelling a wire path resolves to, when more than one folds onto it.
 *
 * **A spelling that already equals its wire form always wins.** That is not a tie-break,
 * it is the point: if `café.md` composed is on disk, writing the wire path reaches it and
 * no translation is needed at all. Only when every candidate is decomposed does the rule
 * fall back to the smaller under plain `<` — deterministic on purpose, because
 * enumeration order is Obsidian's business and a resolution that moves with it is one
 * that changes under the user without their doing anything.
 */
const better = (candidate: string, held: string, wire: string): boolean =>
  held === wire ? false : candidate === wire || candidate < held;

/**
 * The winning disk spelling per wire path. Not exported — the two callers below want
 * different halves of it.
 */
const winners = (paths: Iterable<string>): Map<string, string> => {
  const winner = new Map<string, string>();
  for (const disk of paths) {
    const wire = toWirePath(disk);
    const held = winner.get(wire);
    if (held === undefined || better(disk, held, wire)) winner.set(wire, disk);
  }
  return winner;
};

/**
 * Wire → disk, for the paths where the two differ. **Empty for a vault of ASCII names**,
 * which is why carrying an index costs nothing where the defect does not exist.
 *
 * Pure over a listing: the shell supplies `app.vault.getFiles()` and owns the freshness.
 *
 * A wire path whose winner is its own spelling is absent, not present-and-identity: the
 * lookup then misses and the caller uses the wire path, which is the same answer for one
 * fewer entry.
 */
export const indexOddSpellings = (paths: Iterable<string>): ReadonlyMap<string, string> => {
  const odd = new Map<string, string>();
  for (const [wire, disk] of winners(withAncestors(paths))) if (disk !== wire) odd.set(wire, disk);
  return odd;
};

/**
 * Every path, plus every directory prefix of it.
 *
 * A listing names files; Obsidian's `getFiles()` has no folders in it at all. But a folder
 * is exactly what an inbound write needs translated — a file the vault does not have yet
 * cannot be in the index, so without its parent the write creates a second folder beside
 * the one that exists. The parents are recoverable from the files inside them.
 *
 * A folder holding no files anywhere beneath it is invisible here and stays untranslated.
 * That is the residual: it can only ever gain an empty duplicate, since nothing writes
 * into a folder without naming a file in it.
 */
const withAncestors = (paths: Iterable<string>): string[] => {
  const all = new Set<string>();
  for (const p of paths) {
    all.add(p);
    for (let cut = p.lastIndexOf("/"); cut > 0; cut = p.lastIndexOf("/", cut - 1)) {
      all.add(p.slice(0, cut));
    }
  }
  return [...all];
};

/**
 * The paths a listing would report, NFC and deduped — plus the disk spellings that lost.
 *
 * Reporting both sides of a collision is `unsorted_entries` from the server, which refuses
 * the whole reconnect for every chunk, forever. One file the user is told about beats
 * every file silently failing, so the loser is named rather than dropped in silence.
 *
 * Not sorted here: `scanManifest` sorts under `comparePaths`, and it must sort the
 * spelling the server compares — which is what this returns.
 */
export const foldListing = (
  // An array, not an `Iterable`: this walks it twice, and a generator would silently
  // yield an empty `shadowed` and warn about nothing.
  paths: readonly string[],
): { readonly paths: readonly string[]; readonly shadowed: readonly string[] } => {
  const winner = winners(paths);
  const shadowed: string[] = [];
  for (const disk of paths) {
    if (winner.get(toWirePath(disk)) !== disk) shadowed.push(disk);
  }
  return { paths: [...winner.keys()], shadowed };
};
