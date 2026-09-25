import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ScannableVault, scanManifest } from "./manifest-scan.ts";
import { comparePaths } from "./path-order.ts";
import { classifyPath } from "./safe-path.ts";

/**
 * P7, on the local computation a snapshot reconcile (§8.4) rests on.
 *
 * An earlier prototype's version of this file was about pagination — chunk boundaries an uploaded
 * manifest had to respect. Ours has nothing to paginate (`manifest-scan.ts`'s header
 * explains why), so what survives is the half that was never about chunking at all:
 * every syncable path reported exactly once, in the vault's own order, and nothing the
 * write floor would refuse.
 */

/**
 * Paths chosen so the ORDERING property has teeth: astral-plane names sort differently
 * under `comparePaths` (UTF-8 bytes) than under JavaScript `<` (UTF-16 code units), and
 * an emoji in a filename is routine in an Obsidian vault.
 */
const path = fc.oneof(
  { weight: 6, arbitrary: fc.stringMatching(/^[a-z]{1,10}\.md$/) },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}\.md$/) },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,4}\.png$/) },
  // Above the BMP, plus a neighbour just below E000 — the pair `comparePaths` exists for.
  { weight: 2, arbitrary: fc.constantFrom("🌍.md", "🚀.md", ".md", "�.md", "é.md") },
  // Paths the floor must refuse, so "never reports a refused path" is not vacuous.
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      ".obsidian/plugins/ctrl-notes-cloud-mcp/main.js",
      "run.sh",
      "a.ts",
      "noext",
    ),
  },
);

/** A vault whose files all exist and are small, so `hashOf` never returns null. */
const vaultOf = (files: Record<string, string>): ScannableVault => ({
  list: () => Promise.resolve(Object.keys(files)),
  readBinary: (p) =>
    Promise.resolve(p in files ? new TextEncoder().encode(files[p] as string) : null),
  stat: (p) =>
    Promise.resolve(
      p in files ? { size: new TextEncoder().encode(files[p] as string).length } : null,
    ),
});

const vaultArb = fc
  .dictionary(path, fc.string({ minLength: 0, maxLength: 40 }), { maxKeys: 40 })
  .map((files) => ({ files, vault: vaultOf(files) }));

describe("scanManifest, as a property", () => {
  it("reports every syncable path exactly once, and nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(vaultArb, fc.boolean(), async ({ files, vault }, attachments) => {
        const entries = await scanManifest(vault, { attachments });
        const reported = entries.map((e) => e.path);

        expect(new Set(reported).size).toBe(reported.length);

        const expected = Object.keys(files).filter((p) => {
          const kind = classifyPath(p);
          return kind === "text" || (kind === "attachment" && attachments);
        });
        expect([...reported].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 300 },
    );
  });

  it("is strictly ascending by comparePaths", async () => {
    await fc.assert(
      fc.asyncProperty(vaultArb, async ({ vault }) => {
        const entries = await scanManifest(vault, { attachments: true });
        for (const [prev, next] of entries.slice(1).map((e, i) => [entries[i], e] as const)) {
          expect(comparePaths(prev?.path ?? "", next.path)).toBeLessThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never reports a path the write floor refuses", async () => {
    await fc.assert(
      fc.asyncProperty(vaultArb, fc.boolean(), async ({ vault }, attachments) => {
        const entries = await scanManifest(vault, { attachments });
        for (const { path: p } of entries) {
          expect(classifyPath(p)).not.toBe("refused");
          if (!attachments) expect(classifyPath(p)).not.toBe("attachment");
        }
      }),
      { numRuns: 300 },
    );
  });
});
