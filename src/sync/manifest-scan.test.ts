import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesHash, contentHash } from "./hash.ts";
import { type ScannableVault, scanManifest } from "./manifest-scan.ts";
import { comparePaths } from "./path-order.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const vault = (files: Record<string, string>): ScannableVault => ({
  list: () => Promise.resolve(Object.keys(files)),
  readBinary: (p) => Promise.resolve(p in files ? utf8(files[p] as string) : null),
  stat: () => Promise.resolve(null),
});

/** A vault that holds both kinds of file, and records what was actually read. */
const mixedVault = (opts: {
  text?: Record<string, string>;
  binary?: Record<string, Uint8Array>;
  onReadBinary?: (path: string) => void;
}): ScannableVault => {
  const text = opts.text ?? {};
  const binary = opts.binary ?? {};
  return {
    list: () => Promise.resolve([...Object.keys(text), ...Object.keys(binary)]),
    readBinary: (p) => {
      opts.onReadBinary?.(p);
      return Promise.resolve(binary[p] ?? (p in text ? utf8(text[p] as string) : null));
    },
    stat: (p) =>
      Promise.resolve(p in binary ? { size: (binary[p] as Uint8Array).byteLength } : null),
  };
};

const TEXT_ONLY = { attachments: false } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanManifest", () => {
  it("reports each syncable file with the hash of its bytes", async () => {
    const entries = await scanManifest(vault({ "a.md": "one\n", "b.md": "two\n" }), {
      attachments: true,
    });
    expect(entries).toEqual([
      { path: "a.md", sha: await contentHash("one\n") },
      { path: "b.md", sha: await contentHash("two\n") },
    ]);
  });

  it("omits what the write floor refuses, in both directions", async () => {
    // A path we would never accept inbound is one we must not report either: reporting
    // it invites a reconcile to send changes for it, which the floor would then refuse
    // forever.
    const entries = await scanManifest(
      vault({ "ok.md": "y\n", ".obsidian/app.json": "{}", "hook.sh": "#!/bin/sh\n" }),
      { attachments: true },
    );
    expect(entries.map((e) => e.path)).toEqual(["ok.md"]);
  });

  it("sorts by the normative comparator, not by JavaScript <", async () => {
    // regression: U+1F600 encodes as the surrogate pair D83D DE00, so as UTF-16 code
    // units it sorts BELOW U+FFFD — and as code points it sorts above. An emoji filename
    // is routine in an Obsidian vault, and this function's whole job is a byte-for-byte
    // comparison against a snapshot, so its own order has to agree with the vault's.
    const emoji = "\u{1F600}.md";
    const bmp = "�.md";
    expect(emoji < bmp).toBe(true); // what JavaScript thinks
    const entries = await scanManifest(vault({ [emoji]: "a\n", [bmp]: "b\n" }), {
      attachments: true,
    });
    expect(entries.map((e) => e.path)).toEqual([bmp, emoji]); // what the vault's own order is
  });

  it("is strictly increasing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`n${i}.md`] = `${i}\n`;
    const entries = await scanManifest(vault(files), { attachments: true });
    expect(entries.length).toBe(50);
    for (const [prev, next] of entries.slice(1).map((e, i) => [entries[i], e] as const)) {
      expect(comparePaths(prev?.path ?? "", next.path)).toBeLessThan(0);
    }
  });

  it("skips a file that vanished mid-scan rather than reporting it empty", async () => {
    // The vault is changing underneath us — that is the premise of §6a. A file listed
    // and then gone must not be reported with the hash of "", which a reconcile would
    // read as a real divergence and write an empty file over.
    const scannable: ScannableVault = {
      list: () => Promise.resolve(["gone.md", "here.md"]),
      readBinary: (p) => Promise.resolve(p === "gone.md" ? null : utf8("here\n")),
      stat: () => Promise.resolve(null),
    };
    const entries = await scanManifest(scannable, { attachments: true });
    expect(entries.map((e) => e.path)).toEqual(["here.md"]);
  });

  it("returns nothing for an empty vault", async () => {
    expect(await scanManifest(vault({}), { attachments: true })).toEqual([]);
  });

  it("reports an attachment by the hash of its bytes", async () => {
    const v = mixedVault({ binary: { "img.png": new Uint8Array([1, 2, 3]) } });
    const entries = await scanManifest(v, { attachments: true });
    expect(entries).toContainEqual({
      path: "img.png",
      sha: await bytesHash(new Uint8Array([1, 2, 3])),
    });
  });

  it("skips an attachment whose metadata is unreadable, without reading its bytes", async () => {
    // regression: wire.rs's `MAX_FRAME_BYTES` doc — "a device refused an oversized
    // attachment has already buffered the whole file" — is about `derive.ts`'s upload
    // path, not this scan. This scan has no size ceiling of its own; what it still must
    // never do is read bytes for a file whose metadata it could not even get.
    const read: string[] = [];
    const v: ScannableVault = {
      list: () => Promise.resolve(["gone.png"]),
      readBinary: (p) => {
        read.push(p);
        return Promise.resolve(new Uint8Array([1]));
      },
      stat: () => Promise.resolve(null),
    };
    const entries = await scanManifest(v, { attachments: true });
    expect(entries).toEqual([]);
    expect(read).toEqual([]);
  });

  it("reports no attachments at all when the device holds none", async () => {
    const v = mixedVault({ binary: { "img.png": new Uint8Array([1]) }, text: { "a.md": "x" } });
    const entries = await scanManifest(v, TEXT_ONLY);
    expect(entries.map((e) => e.path)).toEqual(["a.md"]);
  });

  /**
   * A `.base` is text on a device that holds no attachments, which is every device — so
   * it is reported, and the reconcile that follows makes it dirty and pushes it. This is
   * the whole path by which the vault's `base_views` can ever hold a row.
   *
   * **Proven able to fail**: dropping `"base"` from `ALLOWED_EXTENSIONS` empties this
   * result, because the path then classes as an attachment and `TEXT_ONLY` filters it out
   * before `hashOf` is reached.
   */
  it("reports a .base file on a device that carries no attachments", async () => {
    const v = vault({ "People/People.base": "views:\n  - type: table\n" });
    const entries = await scanManifest(v, TEXT_ONLY);
    expect(entries).toEqual([
      { path: "People/People.base", sha: await bytesHash(utf8("views:\n  - type: table\n")) },
    ]);
  });

  /**
   * **An attachment IS reported, and this test asserted the opposite until attachments
   * synced.** The gate was unconditional, mirroring an `apply_upload` that ran
   * `String::from_utf8` over every upload and had no blob branch — correct then, and
   * latent because `main.ts` held attachments back on every device.
   *
   * With `edit::Op::PutBytes` and that getter true, an unconditional gate here is a real
   * disagreement rather than a latent one: `deriveChanges` SENDS an image while this
   * refuses to claim one, so the manifest never names it, `reconcileManifest` marks it
   * dirty on every reconnect, and the device re-reads and re-hashes every attachment it
   * holds to discover each was already in step. The two halves have to ask the same
   * question, and `derive.ts`'s is `classifyPath(path) === "text"`.
   *
   * **Proven able to fail** by restoring the unconditional gate: `img.png` drops out and
   * this reads `["a.md"]`. The `a.md` half isolates it — without it the same red could
   * mean the scan reported nothing at all.
   */
  it("reports an attachment, whose bytes need not be UTF-8", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0xff, 0xfe]);
    const v = mixedVault({
      binary: { "img.png": png },
      text: { "a.md": "x\n" },
    });
    const entries = await scanManifest(v, { attachments: true });
    expect(entries.map((e) => e.path)).toEqual(["a.md", "img.png"]);
    // Claimed by the hash of its actual bytes, not of some decoded rewrite.
    expect(entries.find((e) => e.path === "img.png")?.sha).toBe(await bytesHash(png));
  });

  /**
   * The other half, unchanged: a NOTE whose bytes are not text is still not claimed,
   * because the vault projects it and will answer `BatchError::NotText`. Claiming it
   * starts the per-reconnect refusal loop this gate exists to prevent.
   */
  it("still does not report a NOTE whose bytes are not UTF-8", async () => {
    const v = mixedVault({
      binary: { "broken.md": new Uint8Array([0x89, 0x50, 0x4e, 0xff, 0xfe]) },
      text: { "a.md": "x\n" },
    });
    const entries = await scanManifest(v, { attachments: true });
    expect(entries.map((e) => e.path)).toEqual(["a.md"]);
  });

  /**
   * **One unreadable file must not abandon the whole scan.** `readBinary` returns `null` for
   * "gone before we looked" — but it REJECTS for EACCES, for EIO, and for the check-then-use
   * race where ENOENT lands between `vaultFiles`'s `exists` and its read. That rejection used
   * to escape into `reconcileManifest`, which awaits this before all three of its passes, so
   * one unreadable file cancelled every dirty mark and the whole ledger-deletion pass —
   * identically on every reconnect, for as long as the file stayed unreadable.
   *
   * `z.md` sorts after the failure and is the assertion that matters: it proves the loop
   * CONTINUES rather than merely that the rejection was swallowed. The warning is asserted
   * because a file this device silently stops claiming is the failure the whole reconcile
   * path exists to prevent.
   *
   * **Proven able to fail** by deleting the `try`/`catch` around `hashOf`: this test then
   * fails with the raw `EACCES: permission denied, open 'locked.md'` rather than an
   * assertion, which is what the escape looks like from a caller.
   */
  it("keeps scanning past a path whose read rejects, and says which", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v: ScannableVault = {
      list: () => Promise.resolve(["a.md", "locked.md", "z.md"]),
      readBinary: (p) =>
        p === "locked.md"
          ? Promise.reject(new Error("EACCES: permission denied, open 'locked.md'"))
          : Promise.resolve(utf8(`${p}\n`)),
      stat: () => Promise.resolve(null),
    };
    const entries = await scanManifest(v, TEXT_ONLY);
    expect(entries.map((e) => e.path)).toEqual(["a.md", "z.md"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("locked.md");
  });

  /**
   * The content gate, on the side that starts the loop: a reported path is one the
   * reconcile will make dirty, push, and see refused — with no `current_sha`, so
   * `retry.ts` reports it rather than retrying, and the next reconnect does it again. A
   * path this device cannot sync cleanly is one it must not claim, which is the same rule
   * `safe-path.ts` applies to names, applied to bytes.
   *
   * **Proven able to fail** by deleting the `decodesAsText` call in `hashOf`: both paths
   * are then reported, with the hash of their raw bytes. The `here.md` half is what
   * isolates it — without that, the same red could mean the scan had stopped reporting
   * anything at all.
   */
  it("does not report a text path whose bytes are not UTF-8", async () => {
    const v: ScannableVault = {
      list: () => Promise.resolve(["utf16.txt", "Broken.base", "here.md"]),
      readBinary: (p) =>
        Promise.resolve(
          p === "here.md" ? utf8("here\n") : new Uint8Array([0xff, 0xfe, 0x68, 0x00]),
        ),
      stat: () => Promise.resolve(null),
    };
    const entries = await scanManifest(v, TEXT_ONLY);
    expect(entries.map((e) => e.path)).toEqual(["here.md"]);
  });
});
