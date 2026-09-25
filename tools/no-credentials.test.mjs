import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This repository is public, so nothing committed to it may be a credential. Every
// credential the Ctrl Notes service signs is `<tag>.<base64url>…` — dot-separated — so the
// pattern is the tag, a dot and a base64url run long enough to be a payload rather than
// prose that names the format (`ctr2.<payload>`). `ctr1` and `pra1` are retired and still
// listed: a retired credential pasted into a fixture is still a credential. Key blocks,
// `.secret` files and private-network hosts are refused on the same grounds.
const FORBIDDEN =
  /-----BEGIN|\.secret\b|\b(?:ctr[12]|cra1|dgr1|pra[12]|adm[12]|ent1)\.[A-Za-z0-9_-]{8,}|\.internal\b/;

const root = fileURLToPath(new URL("..", import.meta.url));
const self = "tools/no-credentials.test.mjs";

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && f !== self);

describe("the public repository", () => {
  it("commits nothing shaped like a credential or a private host", () => {
    const files = tracked();
    // A scan of nothing passes anything; the tree always holds the manifest.
    expect(files).toContain("manifest.json");
    for (const file of files) {
      const text = readFileSync(`${root}/${file}`, "utf8");
      expect(text, file).not.toMatch(FORBIDDEN);
    }
  });

  // The scan above passes on any tree that holds nothing it recognises, so it is only as
  // good as its pattern. The service's own export guard once matched `ctr1_…` with an
  // underscore — a shape no credential has had — and so let a real
  // `ctr2.<payload>.<sig>.<secret>` through.
  it("recognises every credential the service renders, and not prose about one", () => {
    const rendered = [
      "ctr2.eyJ0aWQiOiJ0b2sifQ.c2lnbmF0dXJlLWJ5dGVz.c2VjcmV0LWJ5dGVz",
      "cra1.0123456789abcdef0123456789abcdef.c2VjcmV0LWJ5dGVz",
      "dgr1.eyJ2aWQiOiJ2In0.c2lnbmF0dXJl",
      "pra2.eyJwaWQiOiJwIn0.c2lnbmF0dXJl",
      "adm2.eyJ0aWQiOiJ0In0.c2lnbmF0dXJl",
      "ent1.eyJ2aWQiOiJ2In0.c2lnbmF0dXJl",
    ];
    for (const token of rendered) {
      expect(`const t = "${token}";`, token).toMatch(FORBIDDEN);
    }
    for (const prose of [
      "a `ctr2` token",
      "`ctr2.<payload>.<sig>.<secret>`",
      "ctr2 is the agent token",
    ]) {
      expect(prose).not.toMatch(FORBIDDEN);
    }
  });
});
