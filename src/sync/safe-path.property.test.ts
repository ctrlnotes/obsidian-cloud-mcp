import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeInboundPath } from "./safe-path.ts";

/** Mirrors the floor's own reserved-stem rule, so the generator does not fight it. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * P7's property mandate, applied to the plugin's security floor.
 *
 * `safe-path.ts` is the check that stands between a compromised or buggy server and the
 * plugin writing `.obsidian/plugins/ctrl-notes-cloud-mcp/main.js` — its own code, executed on next load.
 * It had table tests only, which is the shape that covers the cases somebody thought of.
 * These are the invariants, over generated input.
 *
 * The plugin carried **no property tests at all** before this file: no fast-check
 * dependency, while owning the merge core that runs against a user's real vault. Its
 * server-side counterparts are fuzzed (`server/src/sync/*.fuzz.test.ts`); this tier was
 * the gap.
 */

/** Path-ish text, weighted toward the shapes that actually reach this function. */
const segment = fc.oneof(
  { weight: 6, arbitrary: fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/) },
  {
    weight: 2,
    arbitrary: fc.constantFrom("notes", "daily", "attachments", ".obsidian", "..", "."),
  },
  { weight: 1, arbitrary: fc.string({ minLength: 0, maxLength: 8 }) },
);

const extension = fc.constantFrom("md", "canvas", "txt", "js", "exe", "png", "", "MD", "Canvas");

const anyPath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), extension)
  .map(([parts, ext]) => (ext === "" ? parts.join("/") : `${parts.join("/")}.${ext}`));

describe("isSafeInboundPath — invariants", () => {
  /**
   * The one that matters most: whatever it accepts must not reach the config directory,
   * where the plugin's own code and its bearer token live (PLUGIN §4a).
   */
  it("never accepts anything under the config directory, in any casing", () => {
    /**
     * `rest` is non-empty deliberately: the config directory has to be a *directory
     * component* for this to be the config directory at all. A first draft allowed zero
     * and the property immediately produced `.obsidian.md` — which is a note named
     * `.obsidian.md` at the vault root, and is correctly accepted. The generator was
     * wrong, not the function, and being forced to say which is the point of the exercise.
     */
    const configPath = fc
      .tuple(
        fc.constantFrom(".obsidian", ".Obsidian", ".OBSIDIAN"),
        fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/), { minLength: 1, maxLength: 3 }),
        fc.constantFrom("md", "canvas", "txt"),
      )
      .map(([head, rest, ext]) => `${[head, ...rest].join("/")}.${ext}`);

    fc.assert(
      fc.property(configPath, (p) => {
        expect(isSafeInboundPath(p), p).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  /** No accepted path may traverse upward, however the traversal is spelled. */
  it("never accepts a path containing a traversal or empty segment", () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        const parts = p.split("/");
        if (parts.some((s) => s === "" || s === "." || s === "..")) {
          expect(isSafeInboundPath(p), p).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The allow-list is the whole design: "refuses anything it does not positively
   * recognise". So acceptance implies one of exactly three extensions — and it must not
   * exceed the server's `TEXT_EXTENSIONS`, or the plugin reports paths it cannot sync.
   */
  it("accepts only md, canvas and txt", () => {
    fc.assert(
      fc.property(anyPath, (p) => {
        if (isSafeInboundPath(p)) {
          const last = p.slice(p.lastIndexOf("/") + 1);
          const ext = last.slice(last.lastIndexOf(".") + 1).toLowerCase();
          expect(["md", "canvas", "txt"], p).toContain(ext);
        }
      }),
      { numRuns: 500 },
    );
  });

  /** Absolute paths, drive letters and backslashes are refused whatever follows them. */
  it("never accepts an absolute, drive-lettered or backslashed path", () => {
    const hostile = fc
      .tuple(fc.constantFrom("/", "C:", "c:/", "\\\\server\\share\\", "\\"), anyPath)
      .map(([prefix, rest]) => prefix + rest);

    fc.assert(
      fc.property(hostile, (p) => {
        expect(isSafeInboundPath(p), p).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Win32 strips trailing dots and spaces per component, so a name the checks inspected
   * is not the name the filesystem uses. Anything ending in one is refused.
   */
  it("never accepts a component with a trailing dot or space", () => {
    const trailing = fc
      .tuple(segment, fc.constantFrom(".", " "), fc.constantFrom("md", "txt"))
      .map(([s, tail, ext]) => `${s}${tail}/note.${ext}`);

    fc.assert(
      fc.property(trailing, (p) => {
        expect(isSafeInboundPath(p), p).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  /** A control character truncates a path in a C API underneath; none may pass. */
  it("never accepts a control character", () => {
    const withControl = fc
      .tuple(
        fc.stringMatching(/^[a-z]{1,6}$/),
        fc.oneof(fc.integer({ min: 0, max: 0x1f }), fc.integer({ min: 0x7f, max: 0x9f })),
      )
      .map(([s, code]) => `${s}${String.fromCharCode(code)}/note.md`);

    fc.assert(
      fc.property(withControl, (p) => {
        expect(isSafeInboundPath(p), p).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  /** Total and pure: same input, same answer, and it never throws on any string. */
  it("is total and deterministic over arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const first = isSafeInboundPath(s);
        expect(typeof first).toBe("boolean");
        expect(isSafeInboundPath(s)).toBe(first);
      }),
      { numRuns: 500 },
    );
  });

  /** A plain, well-formed note path is accepted — so the properties above are not
   *  vacuously satisfied by a function that refuses everything. */
  it("accepts ordinary note paths", () => {
    const ordinary = fc
      .tuple(
        fc.array(
          fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/).filter((d) => !RESERVED.test(d)),
          { minLength: 0, maxLength: 3 },
        ),
        // Reserved stems excluded: they are legitimately refused now, and leaving them
        // in would make this generator produce a counterexample to its own claim.
        fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/).filter((n) => !RESERVED.test(n.split(".")[0]!)),
        fc.constantFrom("md", "canvas", "txt"),
      )
      .map(([dirs, name, ext]) => [...dirs, `${name}.${ext}`].join("/"));

    fc.assert(
      fc.property(ordinary, (p) => {
        expect(isSafeInboundPath(p), p).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
