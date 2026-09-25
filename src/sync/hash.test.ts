import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesHash, contentHash, isWellFormedHash, utf8Bytes } from "./hash.ts";

/**
 * `node:crypto` appears HERE, in a test, and never in `hash.ts` — tests are not bundled, so
 * nothing platform-specific reaches `main.js`. `createHash` below is Node's own SHA-256, used
 * as a same-process differential oracle against `crypto.subtle`. That is a check worth having
 * but it is NOT the load-bearing one: two JavaScript runtimes agreeing with each other says
 * nothing about whether either agrees with the vault, which is the thing `contentHash`'s
 * output must actually address blobs against.
 *
 * That is what "matches the vault's sha256_hex" below is for. The pinned value was produced
 * by calling `apps/vault/src/blobs.rs`'s real `sha256_hex` — not assumed from "it's just
 * SHA-256" — with a temporary `#[test]` in `blobs.rs`'s own test module:
 *
 * ```rust
 * println!("{}", sha256_hex(b"ctrlrouter fixed input for wire probe"));
 * // -> 9cb8a162e33348f687cfa985c72d772f2613c5cc6c317e75b66948e25b5307e0
 * ```
 *
 * run with `cargo test -p vault <name> -- --nocapture`, then reverted — `apps/vault` gains no
 * dependency on this suite, only this comment carries the provenance of the number below.
 */
const serverHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

describe("contentHash", () => {
  it("matches the known SHA-256 of the empty string", async () => {
    // A known answer, not a differential one: if both implementations were wrong in the
    // same way, the differential test below would agree and prove nothing.
    expect(await contentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the vault's own sha256_hex for a fixed input", async () => {
    // Verified against `apps/vault/src/blobs.rs`'s `sha256_hex`, not assumed — see this
    // file's header comment for how. This is the one test in the suite that pins the
    // plugin's addressing to the vault's, rather than to another JavaScript runtime.
    expect(await contentHash("ctrlrouter fixed input for wire probe")).toBe(
      "9cb8a162e33348f687cfa985c72d772f2613c5cc6c317e75b66948e25b5307e0",
    );
  });

  it.each([
    ["empty", ""],
    ["ascii", "hello world"],
    ["a note", "# Title\n\nBody with *emphasis*.\n"],
    ["crlf", "one\r\ntwo\r\n"],
    ["trailing newline absent", "no terminator"],
    ["non-ascii", "café — naïve — 日本語"],
    ["astral plane", "🔒 emoji outside the BMP 𝔘"],
    ["lone surrogate replaced", "before \ud800 after"],
    ["null byte", "a\\0b"],
  ])("agrees with the server's implementation on %s", async (_name, input) => {
    expect(await contentHash(input)).toBe(serverHash(input));
  });

  it("is 64 lowercase hex characters", async () => {
    expect(isWellFormedHash(await contentHash("anything"))).toBe(true);
  });
});

describe("isWellFormedHash", () => {
  it.each([
    ["uppercase hex", "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"],
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(isWellFormedHash(value)).toBe(false);
  });
});

describe("utf8Bytes", () => {
  it.each([
    ["ascii counts one per character", "abc", 3],
    ["accented characters cost two", "café", 5],
    ["cjk costs three", "日本語", 9],
    ["astral costs four", "𝔘", 4],
  ])("%s", (_name, input, expected) => {
    expect(utf8Bytes(input)).toBe(expected);
  });

  it("differs from .length wherever it matters", () => {
    // The cap is measured in bytes; `.length` is UTF-16 code units. Conflating them is how
    // a batch that passes the client's check is refused by the server's.
    expect(utf8Bytes("日本語")).not.toBe("日本語".length);
  });
});

describe("bytesHash", () => {
  const serverBytesHash = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

  it("hashes bytes exactly as the server does", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(await bytesHash(bytes)).toBe(serverBytesHash(bytes));
  });

  it("agrees with contentHash on the same content", async () => {
    expect(await bytesHash(new TextEncoder().encode("hello"))).toBe(await contentHash("hello"));
  });
});
