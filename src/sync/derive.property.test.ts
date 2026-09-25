import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveChanges, syncablePath as isSyncable, type ReadableFiles } from "./derive.ts";
import { contentHash } from "./hash.ts";
import { classifyPath } from "./safe-path.ts";

/**
 * P7, on the one function that decides what leaves this device.
 *
 * Three of its invariants are load-bearing and none of them is local to a line:
 * §4a rule 3 must hold on BOTH sides of a rename; `base` must be a hash the SERVER once
 * held, never one of current disk (quoting disk is the `unknown_base` class of bug); and
 * a device in step must emit nothing, or the inbound path and this one echo each other
 * forever.
 */

const syncablePath = fc.oneof(
  { weight: 6, arbitrary: fc.stringMatching(/^[a-z]{1,10}\.md$/) },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}\.md$/) },
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,4}\.png$/) },
);

/** Paths the floor refuses, so the rule-3 properties are not vacuous. */
const refusedPath = fc.constantFrom(
  ".obsidian/plugins/ctrl-notes-cloud-mcp/main.js",
  ".obsidian/app.json",
  "hook.sh",
  "mod.ts",
  "build.py",
);

const anyPath = fc.oneof(
  { weight: 3, arbitrary: syncablePath },
  { weight: 2, arbitrary: refusedPath },
);

const filesOf = (contents: Record<string, string>): ReadableFiles => ({
  readBinary: (p) =>
    Promise.resolve(p in contents ? new TextEncoder().encode(contents[p] as string) : null),
  stat: (p) =>
    Promise.resolve(
      p in contents ? { size: new TextEncoder().encode(contents[p] as string).length } : null,
    ),
});

/**
 * A whole derive input: what is on disk, what we last synced, and what moved.
 *
 * **`dirty` is drawn FROM the paths on disk**, not independently. Generating it from the
 * same free arbitrary as `contents` made an overlap so rare that `replace` — the branch
 * that carries a `base` at all — was almost never reached, and the base property passed
 * without exercising anything. It is also what Obsidian actually does: it reports events
 * for files that exist. A few strays are mixed in so the "gone before we looked" path
 * still occurs.
 */
const scenario = fc
  .dictionary(anyPath, fc.string({ maxLength: 30 }), { minKeys: 1, maxKeys: 12 })
  .chain((contents) => {
    const onDisk = Object.keys(contents);
    const fromDisk = fc.constantFrom(...onDisk);
    return fc.record({
      contents: fc.constant(contents),
      dirty: fc.array(
        fc.oneof({ weight: 5, arbitrary: fromDisk }, { weight: 1, arbitrary: anyPath }),
        {
          maxLength: 8,
        },
      ),
      deleted: fc.array(
        fc.oneof({ weight: 3, arbitrary: fromDisk }, { weight: 1, arbitrary: anyPath }),
        {
          maxLength: 4,
        },
      ),
      renamed: fc.array(fc.tuple(anyPath, fromDisk), { maxLength: 4 }),
      knownHashes: fc.array(fc.stringMatching(/^[0-9a-f]{64}$/), { minLength: 1, maxLength: 8 }),
      attachments: fc.boolean(),
    });
  })
  .map((s) => {
    // Last-synced hashes for the known paths, drawn from a pool so an emitted `base` can be
    // matched back to the map it must have come from. Deliberately NOT the real hash of the
    // content: a `base` equal to disk is the bug this is looking for.
    const paths = [
      ...new Set([...Object.keys(s.contents), ...s.dirty, ...s.renamed.map((r) => r[1])]),
    ];
    const hashes: Record<string, string> = {};
    paths.forEach((p, i) => {
      const h = s.knownHashes[i % s.knownHashes.length];
      if (h !== undefined) hashes[p] = h;
    });
    return {
      ...s,
      hashes,
      touched: {
        dirty: new Set(s.dirty),
        deleted: new Set(s.deleted),
        renamed: new Map(s.renamed),
      },
    };
  });

describe("deriveChanges, as a property", () => {
  it("never names a path the write floor refuses — on either side of a rename", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { changes } = await deriveChanges(filesOf(s.contents), s.hashes, s.touched, {
          attachments: s.attachments,
        });
        for (const c of changes) {
          expect(classifyPath(c.path)).not.toBe("refused");
          if (!s.attachments) expect(classifyPath(c.path)).not.toBe("attachment");
          // A rename is a write to the destination AND a removal from the source; a
          // deny-listed source must not be moved out from under the rule. The source gets
          // the SAME two clauses as the destination — checking only `refused` let a
          // narrowed guard (`classifyPath(from) === "refused"` instead of `!syncable(from)`)
          // emit a rename whose source is an attachment a text-only device does not hold.
          if (c.op === "rename") {
            expect(classifyPath(c.from)).not.toBe("refused");
            if (!s.attachments) expect(classifyPath(c.from)).not.toBe("attachment");
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("puts every rename before everything else", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { changes } = await deriveChanges(filesOf(s.contents), s.hashes, s.touched, {
          attachments: s.attachments,
        });
        const lastRename = changes.map((c) => c.op === "rename").lastIndexOf(true);
        const firstOther = changes.findIndex((c) => c.op !== "rename");
        // The server has to move a file before it is asked to write to the new path.
        if (lastRename >= 0 && firstOther >= 0) expect(lastRename).toBeLessThan(firstOther);
      }),
      { numRuns: 300 },
    );
  });

  it("quotes a base we were given, never a hash of current disk", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const { changes } = await deriveChanges(filesOf(s.contents), s.hashes, s.touched, {
          attachments: s.attachments,
        });
        const held = new Set(Object.values(s.hashes));
        for (const c of changes) {
          // `put`'s `base` is `null` for a create — that is not a base being quoted at
          // all, so it is excluded rather than asserted about.
          if ("base" in c && c.base !== null) {
            // The vault's own merge (§9) resolves `base` to a content ancestor. A hash of
            // what is on disk now names bytes it never held, and the vault cannot reconcile
            // it against anything real.
            expect(held.has(c.base)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("emits nothing when the hash map already agrees with disk", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(syncablePath, fc.string({ maxLength: 30 }), { maxKeys: 10 }),
        async (contents) => {
          // Only text paths: an attachment's hash is over bytes, and the point here is the
          // echo, not the hashing. Every path is dirty — the strongest form of the claim.
          const text = Object.fromEntries(
            Object.entries(contents).filter(([p]) => classifyPath(p) === "text"),
          );
          const hashes: Record<string, string> = {};
          for (const [p, c] of Object.entries(text)) hashes[p] = await contentHash(c);

          const { changes } = await deriveChanges(filesOf(text), hashes, {
            dirty: new Set(Object.keys(text)),
            deleted: new Set(),
            renamed: new Map(),
          });
          // Anything here is an echo of what the inbound path just applied, and the two
          // would trade it back and forth for as long as the vault is open.
          expect(changes).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/**
 * The predicate itself, which `deriveChanges` above is only one of four callers of.
 *
 * It was written out verbatim in four files whose only coupling was a comment, and PLUGIN
 * §2's "the plugin makes **no reconciliation decisions**" is true only while all four
 * agree. Drift between them is neither a compile error nor a test failure: it is a file
 * that appears in the manifest, comes back in `push`, is never sent, and is refused on
 * every reconnect forever with nothing logged. These properties pin the one definition to
 * `classifyPath` so an edit to either shows up here instead.
 *
 * `anyPath` above already mixes syncable and refused shapes, which is exactly the pool
 * these need — relating two functions means exercising both on the same shapes.
 */
describe("syncablePath, as a property", () => {
  it("is exactly the text set on a device that holds no attachments", () => {
    const seen = { total: 0, syncable: 0 };
    fc.assert(
      fc.property(anyPath, (p) => {
        seen.total += 1;
        const yes = isSyncable(p, false);
        if (yes) seen.syncable += 1;
        expect(yes).toBe(classifyPath(p) === "text");
      }),
      { numRuns: 2_000 },
    );
    // Reported, not assumed: a pool that generated nothing syncable would make this true
    // by never reaching the half that matters.
    expect(seen.syncable).toBeGreaterThan(0);
    expect(seen.syncable).toBeLessThan(seen.total);
  });

  it("is everything not refused on a device that holds them", () => {
    const seen = { attachment: 0 };
    fc.assert(
      fc.property(anyPath, (p) => {
        if (classifyPath(p) === "attachment") seen.attachment += 1;
        expect(isSyncable(p, true)).toBe(classifyPath(p) !== "refused");
      }),
      { numRuns: 2_000 },
    );
    // Without an attachment in the pool this is the same property as the one above.
    expect(seen.attachment).toBeGreaterThan(0);
  });

  it("never turns a refused path syncable, whatever the device holds", () => {
    // The security-relevant direction, and the argument for where this function lives:
    // `attachments` is a device preference and must not be able to open the write floor.
    // `safe-path.ts` owns the floor and takes no such parameter.
    fc.assert(
      fc.property(anyPath, fc.boolean(), (p, attachments) => {
        if (classifyPath(p) === "refused") expect(isSyncable(p, attachments)).toBe(false);
      }),
      { numRuns: 2_000 },
    );
  });

  it("is monotone in `attachments` — turning them on never removes a path", () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        if (isSyncable(p, false)) expect(isSyncable(p, true)).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});
