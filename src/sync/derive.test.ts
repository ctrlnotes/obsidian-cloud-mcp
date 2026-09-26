import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES } from "../wire.ts";
import { deriveChanges, syncablePath, type Touched } from "./derive.ts";
import { contentHash } from "./hash.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A disk whose `readBinary` throws, so a case can prove a file was never read.
 *
 * regression: the push path buffered an oversized attachment before discovering it was
 * oversized — `scanManifest` had always stat'ed first and `deriveChanges` had not, so the
 * cap the wire declares was paid for in full before it was applied.
 */
const unreadable = (path: string, size: number) => ({
  readBinary: () => Promise.reject(new Error(`${path} must never be read`)),
  stat: () => Promise.resolve({ size }),
});

/** A disk that answers by map, so a test states only what it cares about. */
const disk = (files: Record<string, string>) => ({
  // The map holds text, so bytes are that text encoded — which is every path's content
  // now, text and attachment alike (`derive.ts`'s `ReadableFiles`).
  readBinary: (path: string) => Promise.resolve(path in files ? utf8(files[path] as string) : null),
  stat: (path: string) =>
    Promise.resolve(path in files ? { size: utf8(files[path] as string).length } : null),
});

const empty: Touched = { dirty: new Set(), deleted: new Set(), renamed: new Map() };

describe("deriveChanges", () => {
  it("sends nothing when nothing was touched", async () => {
    expect((await deriveChanges(disk({}), {}, empty)).changes).toEqual([]);
  });

  it("creates a path the vault has never seen", async () => {
    const { changes } = await deriveChanges(
      disk({ "a.md": "hi\n" }),
      {},
      {
        ...empty,
        dirty: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([
      {
        op: "put",
        path: "a.md",
        base: null,
        content: utf8("hi\n"),
        hash: await contentHash("hi\n"),
      },
    ]);
  });

  it("replaces a known path, quoting our last-synced hash as base", async () => {
    // `base` is what WE last synced, never what is on disk now — the vault's own merge
    // (§9) resolves a stale one. Quoting the current hash would be bytes the vault never
    // held, and would reject with no `current_sha` to reconcile against.
    const old = await contentHash("old\n");
    const { changes } = await deriveChanges(
      disk({ "a.md": "new\n" }),
      { "a.md": old },
      {
        ...empty,
        dirty: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([
      {
        op: "put",
        path: "a.md",
        base: old,
        content: utf8("new\n"),
        hash: await contentHash("new\n"),
      },
    ]);
  });

  it("sends nothing when disk already matches what we synced", async () => {
    // THE echo-suppression case. Applying an inbound change fires a modify event, and
    // without this the plugin pushes the vault's own write straight back at it.
    const same = await contentHash("same\n");
    const { changes } = await deriveChanges(
      disk({ "a.md": "same\n" }),
      { "a.md": same },
      {
        ...empty,
        dirty: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([]);
  });

  it("deletes an observed deletion of a known path", async () => {
    const base = await contentHash("gone\n");
    const { changes } = await deriveChanges(
      disk({}),
      { "a.md": base },
      {
        ...empty,
        deleted: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([{ op: "delete", path: "a.md", base }]);
  });

  it("says nothing about deleting a path the vault never had", async () => {
    const { changes } = await deriveChanges(disk({}), {}, { ...empty, deleted: new Set(["a.md"]) });
    expect(changes).toEqual([]);
  });

  it("renames a known path, and does not also re-create it", async () => {
    const base = await contentHash("body\n");
    const { changes } = await deriveChanges(
      disk({ "new.md": "body\n" }),
      { "old.md": base },
      {
        ...empty,
        renamed: new Map([["new.md", "old.md"]]),
        dirty: new Set(["new.md"]),
      },
    );
    expect(changes).toEqual([{ op: "rename", path: "new.md", from: "old.md", base }]);
  });

  it("drops a rename that only changed how the name is spelled", async () => {
    // regression: `main.ts` normalises both sides of a rename, so a decomposed name
    // re-spelled composed collapses to one path. Sending `{from: X, path: X}` retires
    // the very base its own result sets — `forget` is applied AFTER the hashes merge —
    // so the next edit derives as a `create` and earns a conflict copy.
    const nfc = "café.md".normalize("NFC");
    const base = await contentHash("body\n");
    const { changes } = await deriveChanges(
      disk({ [nfc]: "body\n" }),
      { [nfc]: base },
      { ...empty, renamed: new Map([[nfc, nfc]]), dirty: new Set() },
    );
    expect(changes).toEqual([]);
  });

  it("renames and then replaces when the content moved too", async () => {
    // Obsidian fires rename and modify separately, so both can be pending for one file.
    // Order matters: the vault must move the file before it is asked to write to it.
    const base = await contentHash("body\n");
    const { changes } = await deriveChanges(
      disk({ "new.md": "edited\n" }),
      { "old.md": base },
      {
        ...empty,
        renamed: new Map([["new.md", "old.md"]]),
        dirty: new Set(["new.md"]),
      },
    );
    expect(changes).toEqual([
      { op: "rename", path: "new.md", from: "old.md", base },
      {
        op: "put",
        path: "new.md",
        base,
        content: utf8("edited\n"),
        hash: await contentHash("edited\n"),
      },
    ]);
  });

  it("treats a rename of a path the vault never had as a create", async () => {
    const { changes } = await deriveChanges(
      disk({ "new.md": "body\n" }),
      {},
      {
        ...empty,
        renamed: new Map([["new.md", "old.md"]]),
        dirty: new Set(["new.md"]),
      },
    );
    expect(changes).toEqual([
      {
        op: "put",
        path: "new.md",
        base: null,
        content: utf8("body\n"),
        hash: await contentHash("body\n"),
      },
    ]);
  });

  it("refuses to send a path the write floor rejects", async () => {
    // The same predicate that guards inbound writes. A note named `.obsidian/x.json` or
    // `hook.sh` is not ours to sync in either direction.
    const { changes } = await deriveChanges(
      disk({ ".obsidian/app.json": "{}", "hook.sh": "#!/bin/sh\n", "ok.md": "y\n" }),
      {},
      { ...empty, dirty: new Set([".obsidian/app.json", "hook.sh", "ok.md"]) },
    );
    expect(changes.map((c) => c.path)).toEqual(["ok.md"]);
  });

  it("skips a dirty path that vanished before the settle", async () => {
    // Touched then deleted within one window, with no delete event observed (it may have
    // been moved out by another tool). Absence alone is never a deletion (§6a).
    const { changes } = await deriveChanges(
      disk({}),
      { "a.md": "a".repeat(64) },
      {
        ...empty,
        dirty: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([]);
  });

  /**
   * The check-then-use race between `stat`/`read`/`readBinary` and the
   * filesystem changing underneath them does not always come back as `null` — it can throw
   * (ENOENT, a permission error). The case above already covers `null`; this covers the
   * other half, which used to escape `deriveChanges` entirely and, with `main.ts`'s own
   * `touched` already emptied by the time it awaited this, lost every OTHER dirty path in
   * the same settle along with it.
   */
  it("skips a path whose read throws, and keeps deriving the rest of the batch", async () => {
    const good = disk({ "a.md": "boom\n", "b.md": "yes\n" });
    const flaky = {
      ...good,
      readBinary: (path: string) =>
        path === "a.md" ? Promise.reject(new Error("EIO")) : good.readBinary(path),
    };
    const { changes } = await deriveChanges(
      flaky,
      {},
      {
        ...empty,
        dirty: new Set(["a.md", "b.md"]),
      },
    );
    expect(changes.map((c) => c.path)).toEqual(["b.md"]);
  });

  it("emits renames before everything else", async () => {
    const base = await contentHash("b\n");
    const { changes } = await deriveChanges(
      disk({ "new.md": "b\n", "other.md": "x\n" }),
      { "old.md": base },
      {
        dirty: new Set(["other.md", "new.md"]),
        deleted: new Set(),
        renamed: new Map([["new.md", "old.md"]]),
      },
    );
    expect(changes[0]?.op).toBe("rename");
  });

  it("re-creates rather than deletes when a path is deleted and written again in one window", async () => {
    // regression: delete-then-create inside one settle window emitted only the delete,
    // destroying vault-side a file that is on disk. Several editors (and Obsidian Sync)
    // replace a file exactly that way, and nothing was dirty on the next settle to undo
    // it. Absence still governs the other direction: a deleted path that is really gone
    // is still a delete.
    const base = await contentHash("old\n");
    const { changes } = await deriveChanges(
      disk({ "a.md": "recreated\n" }),
      { "a.md": base },
      {
        ...empty,
        dirty: new Set(["a.md"]),
        deleted: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([
      {
        op: "put",
        path: "a.md",
        base,
        content: utf8("recreated\n"),
        hash: await contentHash("recreated\n"),
      },
    ]);
  });

  it("still deletes when the deleted path did not come back", async () => {
    const base = await contentHash("old\n");
    const { changes } = await deriveChanges(
      disk({}),
      { "a.md": base },
      {
        ...empty,
        dirty: new Set(["a.md"]),
        deleted: new Set(["a.md"]),
      },
    );
    expect(changes).toEqual([{ op: "delete", path: "a.md", base }]);
  });

  /**
   * Named deleted and NOT dirty, still on disk: what a reconcile reading a listing that
   * trailed the disk produced — it clears `dirty` for every path it marks deleted, so
   * `alive` never saw this one. 9,759 notes were deleted vault-wide that way on 2026-09-26.
   *
   * **Proven able to fail** by removing the `stat` before `deletes.push`: `changes` holds a
   * `delete` for `a.md`.
   */
  it("does not delete a path it was told was deleted that is still on disk", async () => {
    const { changes } = await deriveChanges(
      disk({ "a.md": "still here\n" }),
      { "a.md": await contentHash("still here\n") },
      { ...empty, deleted: new Set(["a.md"]) },
    );
    expect(changes).toEqual([]);
  });

  it("does not delete a path whose presence it could not check", async () => {
    const { changes } = await deriveChanges(
      {
        readBinary: () => Promise.resolve(null),
        stat: () => Promise.reject(new Error("EACCES")),
      },
      { "a.md": "a".repeat(64) },
      { ...empty, deleted: new Set(["a.md"]) },
    );
    expect(changes).toEqual([]);
  });

  it("creates a NEW file at the path a rename just vacated", async () => {
    // regression: the rename retires hashes[from], so a fresh file at the old path is a
    // create. Quoting the retired hash emitted a replace against a base that is no longer
    // at that path once the rename (sent first) lands — a permanent, unresolvable refusal.
    const base = await contentHash("body\n");
    const { changes } = await deriveChanges(
      disk({ "moved.md": "body\n", "note.md": "brand new\n" }),
      { "note.md": base },
      {
        ...empty,
        renamed: new Map([["moved.md", "note.md"]]),
        dirty: new Set(["moved.md", "note.md"]),
      },
    );
    expect(changes).toEqual([
      { op: "rename", path: "moved.md", from: "note.md", base },
      {
        op: "put",
        path: "note.md",
        base: null,
        content: utf8("brand new\n"),
        hash: await contentHash("brand new\n"),
      },
    ]);
  });

  it("does not delete an oversized file that is on disk", async () => {
    // regression: the oversize `continue` jumped over `alive.add(path)`, so a
    // delete-then-create window — how several editors replace a file atomically — emitted
    // a `delete` for a file sitting on disk. The vault would then propagate that deletion
    // to every other device. Skipping is not deleting: the vault is told nothing.
    const big = {
      readBinary: () => Promise.reject(new Error("must never be read")),
      stat: () => Promise.resolve({ size: MAX_FRAME_BYTES + 1 }),
    };
    const out = await deriveChanges(
      big,
      { "big.png": "a".repeat(64) },
      {
        dirty: new Set(["big.png"]),
        deleted: new Set(["big.png"]),
        renamed: new Map(),
      },
    );

    expect(out.changes).toEqual([]);
    expect(out.oversize).toEqual(["big.png"]);
  });

  it("carries a file of exactly the cap", async () => {
    // The boundary is `>`, not `>=`: `MAX_FRAME_BYTES` is inclusive, so a file of exactly
    // that size is sendable and refusing it would strand a legal file forever.
    const atCap = "x".repeat(MAX_FRAME_BYTES);
    const out = await deriveChanges(
      {
        readBinary: () => Promise.resolve(new TextEncoder().encode(atCap)),
        stat: () => Promise.resolve({ size: MAX_FRAME_BYTES }),
      },
      {},
      { dirty: new Set(["ok.png"]), deleted: new Set(), renamed: new Map() },
    );

    expect(out.oversize).toEqual([]);
    expect(out.changes.map((c) => c.op)).toEqual(["put"]);
  });

  it("never reads a file the vault will not buffer", async () => {
    const out = await deriveChanges(
      unreadable("huge.png", MAX_FRAME_BYTES + 1),
      {},
      { dirty: new Set(["huge.png"]), deleted: new Set(), renamed: new Map() },
    );

    // Resolving at all is half the assertion: `readBinary` rejects, so reaching it fails
    // the case rather than merely making it slow.
    expect(out.changes).toEqual([]);
    // Named, not swallowed — the shell tells the user, and a file silently absent is the
    // failure this whole path is about.
    expect(out.oversize).toEqual(["huge.png"]);
  });

  /**
   * A `.base` is Obsidian's own YAML, and until it could leave a device the vault's whole
   * bases read surface compiled nothing: `base_views` had no way to gain a row.
   *
   * **Proven able to fail**: dropping `"base"` from `ALLOWED_EXTENSIONS` empties
   * `changes` here — the path classes as an attachment, and `attachments: false` (what
   * every device passes today) withholds it.
   */
  it("derives a put for a .base file, which is where the vault's bases come from", async () => {
    const base = 'filters:\n  and:\n    - file.folder == "Notes"\n';
    const out = await deriveChanges(
      disk({ "Notes Base.base": base }),
      {},
      { ...empty, dirty: new Set(["Notes Base.base"]) },
      { attachments: false },
    );

    expect(out.changes).toEqual([
      {
        op: "put",
        path: "Notes Base.base",
        base: null,
        content: utf8(base),
        hash: await contentHash(base),
      },
    ]);
  });

  /**
   * The gate the extension above could not provide on its own.
   *
   * The vault answers `String::from_utf8`'s failure with a `Refused` carrying no
   * `current_sha`, which `retry.ts` reports rather than retries — so a path pushed once is
   * pushed again on every reconnect, with nothing on disk changing to end it. Withholding
   * it here is the only place that loop can be cut, and the user is told which files and
   * why (`main.ts` prints `undecodable`).
   *
   * **Proven able to fail** by deleting the `decodesAsText` guard in `deriveChanges`: both
   * paths are then derived as puts (`changes` has two entries, `undecodable` is empty).
   * The `oversize` assertion cannot fire first — neither file is anywhere near the cap —
   * and the `changes` assertion alone would also pass if the guard threw instead of
   * withholding, which is why `undecodable` is asserted by name.
   */
  it("withholds a text path whose bytes are not UTF-8, and names it", async () => {
    // UTF-16LE with a BOM, which is what a `.txt` re-saved in another editor looks like,
    // and the same bytes in a `.base` — the format this commit put back on the list.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const out = await deriveChanges(
      {
        readBinary: () => Promise.resolve(utf16),
        stat: () => Promise.resolve({ size: utf16.byteLength }),
      },
      {},
      { ...empty, dirty: new Set(["notes.txt", "Broken.base"]) },
      { attachments: false },
    );

    expect(out.changes).toEqual([]);
    expect(out.undecodable.sort()).toEqual(["Broken.base", "notes.txt"]);
    expect(out.oversize).toEqual([]);
  });

  /**
   * Withholding is not deleting — the same asymmetry the oversize case above pins, and
   * the more expensive one to get wrong: a `delete` derived for a file sitting on this
   * disk is propagated by the vault to every other device.
   *
   * **Proven able to fail** by moving the `decodesAsText` guard above `alive.add(path)`
   * (the shape the oversize branch had before its own regression): `changes` then holds a
   * `delete` for `notes.txt`. The `undecodable` assertion in the case above cannot stand in
   * for this one — it passes under that mutation too.
   */
  it("does not delete an undecodable file that is on disk", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00]);
    const out = await deriveChanges(
      {
        readBinary: () => Promise.resolve(utf16),
        stat: () => Promise.resolve({ size: utf16.byteLength }),
      },
      { "notes.txt": "a".repeat(64) },
      {
        dirty: new Set(["notes.txt"]),
        deleted: new Set(["notes.txt"]),
        renamed: new Map(),
      },
    );

    expect(out.changes).toEqual([]);
    expect(out.undecodable).toEqual(["notes.txt"]);
  });

  /**
   * The gate is PATH-scoped now, and it is scoped that way because the vault's is.
   *
   * This test asserted the opposite until attachments landed, for a reason that was true
   * then: `apply_upload` ran `String::from_utf8` over EVERY completed upload and had no
   * blob branch, so a `.png` derived here was one the vault refused with no `current_sha`
   * — reported rather than retried by `retry.ts`, and pushed again on every reconnect,
   * forever. Withholding it was the only safe answer while that was so.
   *
   * `Op::PutBytes` changed what is true. The vault now decides by path exactly as this
   * does: text is required where `projections::projects_content` says the content is
   * projected, and an attachment is stored without ever being decoded. The two sides
   * agree, which is the property that matters — `safe-path.ts`'s asymmetry rule is about
   * this device never pushing what the vault must refuse.
   *
   * **Proven able to fail** by restoring `attachments: false` above, or by putting the
   * unconditional `!decodesAsText(bytes)` guard back in `derive.ts`: `changes` is then
   * empty and `undecodable` holds `img.png`.
   */
  it("sends an attachment whose bytes are not UTF-8, on a device that holds them", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const out = await deriveChanges(
      {
        readBinary: () => Promise.resolve(png),
        stat: () => Promise.resolve({ size: png.byteLength }),
      },
      {},
      { ...empty, dirty: new Set(["img.png"]) },
      { attachments: true },
    );

    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toMatchObject({ op: "put", path: "img.png" });
    // The bytes go up unchanged — not decoded, not re-encoded. What leaves this device
    // is what is on the disk, which is what the vault hashes.
    expect((out.changes[0] as { content: Uint8Array }).content).toEqual(png);
    expect(out.undecodable).toEqual([]);
    expect(out.oversize).toEqual([]);
  });

  /**
   * The other half of the same rule, and the one that must NOT have loosened.
   *
   * A `.md` is projected — `projections::projects_content` — so the vault requires it to
   * be text and answers `BatchError::NotText` when it is not. Withholding here says the
   * same thing without spending a round trip on it every reconnect, and it keeps
   * `safe-path.ts`'s asymmetry the safe way round: a path this device withholds is merely
   * not synced, while a path it pushes and the vault refuses is refused forever.
   *
   * **Proven able to fail** by dropping the `classifyPath(path) === "text" &&` condition:
   * `notes.md` is then sent as raw bytes and `undecodable` is empty.
   */
  it("still withholds a NOTE whose bytes are not UTF-8", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const out = await deriveChanges(
      {
        readBinary: () => Promise.resolve(png),
        stat: () => Promise.resolve({ size: png.byteLength }),
      },
      {},
      { ...empty, dirty: new Set(["notes.md"]) },
      { attachments: true },
    );

    expect(out.changes).toEqual([]);
    expect(out.undecodable).toEqual(["notes.md"]);
    expect(out.oversize).toEqual([]);
  });
});

describe("syncablePath", () => {
  // The one definition, called from `deriveChanges`, `planReconcile`, `scanManifest` and
  // the shell's own filter. It was four verbatim copies whose only coupling was a comment
  // saying "see `deriveChanges`, which mirrors this".
  it.each([
    ["a.md", false, true],
    ["a.png", false, false],
    ["a.png", true, true],
    ["hook.sh", true, false],
    [".obsidian/x.json", true, false],
    // The corpus's own two `.base` files, at both spellings the research doc measured —
    // one at the vault root, one inside the folder its own view selects. **With
    // `attachments: false`**, which is what every device passes today (`main.ts`'s
    // getter is hardcoded), because that is the setting under which the whole bases read
    // surface was receiving nothing: before `base` was on the allow-list these classed as
    // attachments, and an attachment on a device that holds none is not syncable.
    ["Notes Base.base", false, true],
    ["People/People.base", false, true],
  ])("(%s, %s) is %s", (path, attachments, expected) => {
    expect(syncablePath(path, attachments)).toBe(expected);
  });
});
