/**
 * Content hashing: SHA-256 over UTF-8 bytes, lowercase hex.
 *
 * **This is the vault's own addressing scheme, not merely a format the two sides agree
 * on.** `apps/vault/src/blobs.rs`'s `sha256_hex` is `Sha256::update` then `hex::encode` —
 * plain SHA-256, lowercase hex, over the bytes as given. This file is the plugin-side
 * counterpart: `crypto.subtle.digest("SHA-256", …)` over the UTF-8 encoding of the content,
 * which is the same bytes the vault hashes for inline (text) blobs.
 *
 * `hash.test.ts` pins agreement against the vault's real output for a fixed input (not
 * merely against Node's own `createHash`, which would only prove two JavaScript runtimes
 * agree with each other) — see that file's header for how the pinned value was produced.
 * Async rather than an earlier prototype's synchronous `node:crypto` original, because Obsidian's mobile
 * WebView has no `node:crypto` and this file has no write-segment interleaving hazard to
 * avoid by staying synchronous.
 */

/**
 * Lowercase hex SHA-256 of the content's UTF-8 bytes.
 *
 * **Nothing on the sync path hashes a string any more.** Both halves read and write the
 * bytes on disk and go through {@link bytesHash} — `derive.ts` since the content gate
 * landed, `apply.ts` since the write side stopped decoding (a stripped BOM is what that
 * cost). This stays because it is how the TESTS say "the sha of this text", and because
 * `hash.test.ts` pins agreement with the vault's own `sha256_hex` through it.
 */
export const contentHash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** The same SHA-256 as {@link contentHash}, entered from bytes rather than a string. */
export const bytesHash = async (bytes: Uint8Array): Promise<string> => {
  // A copy typed over a plain `ArrayBuffer`, which is what `BufferSource` accepts: the
  // caller's view may sit on a `SharedArrayBuffer` as far as the types know.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

export const isWellFormedHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

/** UTF-8 byte length — what the wire's size caps are measured in, not `.length`. */
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
