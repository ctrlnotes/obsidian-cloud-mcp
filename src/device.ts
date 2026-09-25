// A device's identity (write-surface design §8.5, plugin design §4.1): an ed25519 keypair
// generated on first use, kept for the life of the install, and never leaving this device.
//
// **The rule this file exists to satisfy — rule 1: the private key is written through
// `app.secretStorage`, NEVER through `saveData`.** `saveData` writes
// `.obsidian/plugins/<id>/data.json` INSIDE the vault, so Obsidian Sync (or any other
// vault-folder sync) replicates it to every other device — turning a device identity into a
// shared bearer token and making "revoke this device" meaningless. It behaves identically on
// one device, so only a test catches it (`device.test.ts`).
//
// **What this does NOT claim.** `secretStorage` is shared across every installed plugin by
// design and is not encrypted at rest today (design §4.1) — this file does not protect the
// key from another plugin on the same device, and nothing here should claim otherwise. The
// property that matters is that the key never LEAVES the device, which both `secretStorage`
// and `saveLocalStorage` satisfy and `saveData` does not.
//
// **Ed25519 comes from `@noble/ed25519`, not WebCrypto** (design §4.2): Ed25519 support in
// WebCrypto is too recent to assume across the WebViews Obsidian mobile actually runs on.
// Checked at the point of adding it (2026-08-25): `@noble/ed25519@3.1.0`, ~5 KB, widely used,
// audited (Cure53, 2022 — see the package's own README for the report link; re-check before
// shipping if this dependency is bumped across a major). Its async API (`keygenAsync`,
// `signAsync`, `getPublicKeyAsync`) leans on `globalThis.crypto` only for SHA-512 hashing and
// CSPRNG bytes — both universally available — and does none of the curve arithmetic there,
// so it behaves identically on desktop and mobile.

import { getPublicKeyAsync, keygenAsync, signAsync } from "@noble/ed25519";

/** The one `secretStorage` id this plugin's device key lives under. */
export const SECRET_ID = "ctrlrouter-device-private-key";

/**
 * The prefix a signed challenge is domain-separated with.
 *
 * **Byte-identical to `share::device::SYNC_CONTEXT_PREFIX`** (`crates/share/src/device.rs`).
 * Not covered by the wire contract (`wire/vault-sync/`) because it is not a frame — it never
 * appears in any JSON frame, only inside the bytes a signature is computed over — so it is
 * matched here by hand, and only a real connection would catch a mismatch.
 */
const SYNC_CONTEXT_PREFIX = "ctrlrouter-sync-v1";

/**
 * The prefix a ROUTING proof is domain-separated with (design O6).
 *
 * **Byte-identical to `share::device::ROUTING_CONTEXT_PREFIX`**, and matched by hand for
 * the same reason as the two beside it — it is signed over, never sent as a frame. Unlike
 * those two, the message it prefixes IS pinned by a fixture,
 * `wire/sync-routing/routing-context-message.json`, which both languages read.
 */
const ROUTING_CONTEXT_PREFIX = "ctrlrouter-sync-routing-v1";

/**
 * The prefix a pairing-intent proof is domain-separated with (design D14).
 *
 * **Byte-identical to `share::device::INTENT_CONTEXT_PREFIX`**, and deliberately not an
 * extension of {@link SYNC_CONTEXT_PREFIX}: neither is a prefix of the other, so no intent
 * message can ever equal a sync message. A device tricked into signing one must not thereby
 * have signed the other. Unlike the sync prefix above, this one IS covered by a
 * cross-language fixture — `wire/pairing-intent/` — because it is checkable without a live
 * connection: the message is a pure function of two values both sides can be handed.
 */
const INTENT_CONTEXT_PREFIX = "ctrlrouter-pairing-intent-v1";

/**
 * How many bytes a challenge carries, on either flow. **Mirrors
 * `share::device::CHALLENGE_BYTES`** (32, from the server's CSPRNG).
 *
 * Held here so a caller can refuse a challenge of any other length BEFORE signing it. The
 * server would refuse the round trip anyway — `RetrievePairingResultError::Malformed` — but
 * that arrives as an opaque 400 after this device has already put its signature over bytes
 * somebody else chose the length of. See `intentContextMessage`'s note on why the challenge
 * being fixed-length is what makes the concatenation unambiguous.
 */
export const CHALLENGE_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The device's public key, re-encoded as STANDARD base64 (with `+`/`/` and `=` padding) —
 * what a pairing redemption actually decodes on the wire. Both
 * `apps/controlplane/src/http/routes/pairings.rs`'s `RedeemBody.public_key` and
 * `apps/vault/src/http/routes/pairing.rs`'s own copy of it are decoded with
 * `base64::engine::general_purpose::STANDARD`, never the URL-safe alphabet.
 *
 * **`publicKeyBase64` above is the wrong encoding for that field**, on purpose elsewhere: it
 * is base64URL, unpadded, because that is what belongs in `hello`'s `device_id` sibling
 * fields and in this file's own tests. Sending it unconverted to `/redeem` fails to decode
 * for any key whose bytes need a `+`, `/` or the padding STANDARD requires and this
 * alphabet omits — which is most keys, not an edge case. `adopt.ts` is the one caller
 * that needs the STANDARD form, so the conversion lives here, next to the encoding it
 * un-does, rather than duplicated at that call site.
 */
export function publicKeyStandardBase64(identity: Pick<DeviceIdentity, "publicKeyBase64">): string {
  const bytes = fromBase64Url(identity.publicKeyBase64);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode base64url, no padding — **total**: anything that is not exactly that reads as
 * `null` rather than throwing.
 *
 * The one caller is `pairing-intent.ts`, decoding a challenge that arrived off the wire, and
 * `controlplane-http.ts`'s posture applies to it: a sync-adjacent flow runs unattended
 * inside somebody else's application, so a malformed response is a value to report, never an
 * unhandled rejection with this plugin's name on it.
 *
 * **The alphabet check is not redundant.** `atob` is a STANDARD-base64 decoder: handed
 * `a+b/c` it decodes happily, so without this test a STANDARD-alphabet string would come
 * back as *different bytes* instead of as a refusal — the same `+`/`/` confusion
 * {@link publicKeyStandardBase64} exists for, one direction over. A length of `4n + 1`
 * encodes no whole number of bytes and is rejected for the same reason.
 */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

/**
 * The bytes a device actually signs for one vault's challenge — rule 3, and the reason
 * `signChallenge` exists at all rather than signing the challenge bare. Must match
 * `share::device::context_message` exactly: `SYNC_CONTEXT_PREFIX || vault_id || challenge`,
 * with `vault_id` and the prefix as their raw UTF-8 bytes and no separators between the three
 * parts.
 *
 * Exported (only `device.test.ts` imports it) so that pin can compare BYTES directly against
 * a hand-built message, rather than through determinism alone — determinism is a property of
 * ed25519, not of this function's layout, and a test that only checked signatures were
 * reproducible passed just as well with the prefix and vault id swapped (major finding).
 */
export function contextMessage(vaultId: string, challenge: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(SYNC_CONTEXT_PREFIX);
  const vault = new TextEncoder().encode(vaultId);
  const out = new Uint8Array(prefix.length + vault.length + challenge.length);
  out.set(prefix, 0);
  out.set(vault, prefix.length);
  out.set(challenge, prefix.length + vault.length);
  return out;
}

/**
 * The bytes a device signs so the CONTROL PLANE will route its socket to its vault
 * (device-approval O6).
 *
 * **Must match `share::device::routing_context_message` exactly**, and unlike the two
 * messages beside it BOTH variable parts are length-prefixed with a big-endian `u32`:
 * `ROUTING_PREFIX || len(deviceId) || deviceId || len(vaultId) || vaultId || at_ms`, with
 * `at_ms` a big-endian signed 64-bit integer. The Rust side's comment gives the reason —
 * `prefix || a || b` is ambiguous when both parts vary, and here they do, so without the
 * lengths one signature would authorise routing to a vault the device never named.
 *
 * **This is a routing proof, not an authentication.** It says only "send my socket to this
 * vault"; the vault then runs its own challenge through {@link contextMessage} and checks
 * revocation. Nothing here grants access to anything.
 */
export function routingContextMessage(deviceId: string, vaultId: string, atMs: number): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode(ROUTING_CONTEXT_PREFIX);
  const device = enc.encode(deviceId);
  const vault = enc.encode(vaultId);
  const out = new Uint8Array(prefix.length + 4 + device.length + 4 + vault.length + 8);
  const view = new DataView(out.buffer);
  let at = 0;
  out.set(prefix, at);
  at += prefix.length;
  view.setUint32(at, device.length, false);
  at += 4;
  out.set(device, at);
  at += device.length;
  view.setUint32(at, vault.length, false);
  at += 4;
  out.set(vault, at);
  at += vault.length;
  // `setBigInt64` rather than two 32-bit halves: the Rust side writes an i64,
  // and a millisecond timestamp passed 2^53 would lose precision through
  // `number` long before it overflowed the field.
  view.setBigInt64(at, BigInt(atMs), false);
  return out;
}

/**
 * The bytes a device signs to prove it may READ a pairing intent's result (design D14):
 * `INTENT_CONTEXT_PREFIX || intent_id || challenge`, raw UTF-8, no separators.
 *
 * **Must match `share::device::intent_context_message` exactly.** Nothing type-checks across
 * that boundary and the message never appears on the wire — only a `challenge` and a
 * `signature` do — so a different order or a stray separator produces signatures that simply
 * never verify. AT8 folds "unknown intent", "expired intent" and "that signature does not
 * verify" into one `no-such-pairing-intent`, so the mistake would present as an intent that
 * mysteriously does not exist. `wire/pairing-intent/` is the pin (PL7).
 *
 * **What this proves, and what it does not.** A device that signs this may read the intent's
 * result. It says nothing about who CHOSE that result — design §5.3 records that exact
 * confusion killing two drafts — which is why nothing may be adopted from the answer without
 * the local gate (D19).
 *
 * **Why the challenge is last and fixed-length.** `intent_id` is variable length, so the
 * concatenation would be ambiguous if both variable parts were attacker-chosen. They are
 * not: the id is server-minted and the challenge is exactly {@link CHALLENGE_BYTES}, which
 * is why `pairing-intent.ts` checks that length before signing rather than after.
 */
export function intentContextMessage(intentId: string, challenge: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(INTENT_CONTEXT_PREFIX);
  const intent = new TextEncoder().encode(intentId);
  const out = new Uint8Array(prefix.length + intent.length + challenge.length);
  out.set(prefix, 0);
  out.set(intent, prefix.length);
  out.set(challenge, prefix.length + intent.length);
  return out;
}

/**
 * Destroy this device's private key (design §6.3's "Disconnect this device").
 *
 * **Overwritten, not deleted, because Obsidian offers no delete.** `SecretStorage` exposes
 * `setSecret`, `getSecret` and `listSecrets` and nothing else (checked against
 * `obsidian.d.ts` 1.13.1), so the strongest thing available is to replace the key material
 * with a value that is not one. {@link DeviceIdentity.load} treats `""` as "no key", so the
 * next load generates a fresh keypair rather than resurrecting this one.
 *
 * **What this does and does not buy.** It does not revoke anything: the vault row stays
 * trusted until somebody removes it from the device list (§6.3 — no revoke path is
 * reachable from the plugin). What it buys is that THIS installation can no longer prove
 * possession of that registration, which is the only half of a revocation a device can
 * honestly perform on its own. A key left in `secretStorage` after a disconnect is a
 * credential for a vault the user believes they have left.
 *
 * **`SECRET_ID` alone.** Every plugin shares one `secretStorage` namespace (this module's
 * header), so anything broader would erase another plugin's secrets.
 */
export async function forgetDeviceKey(app: SecretStorageHost): Promise<void> {
  await app.secretStorage.setSecret(SECRET_ID, "");
}

/**
 * The slice of Obsidian's `App` this module touches — not the whole `App` type, so a test can
 * hand it a minimal fake instead of standing up the real Obsidian API surface.
 */
export interface SecretStorageHost {
  secretStorage: {
    getSecret(id: string): string | null | undefined | Promise<string | null | undefined>;
    setSecret(id: string, value: string): void | Promise<void>;
    listSecrets(): string[] | Promise<string[]>;
  };
}

/** This device's ed25519 identity. There is no way to read the private key back out. */
export class DeviceIdentity {
  /**
   * A real private field (nit fix), not TypeScript `private` — that is erased at runtime,
   * so `secretKey` would otherwise be a plain own enumerable property and something like
   * `JSON.stringify(identity)` or a spread into a log line would emit it. Nothing in this
   * plugin currently does that (`main.ts` only ever passes narrow `Pick<...>` views of this
   * class onward), so the type system alone happened to be enough so far — `#` makes it
   * enough on purpose. `settle.ts`'s own comment deliberately avoids `#` for a hot,
   * per-event class where bundle size is the trade that matters; a single long-lived
   * identity object is a different trade.
   */
  readonly #secretKey: Uint8Array;
  readonly publicKeyBase64: string;

  private constructor(secretKey: Uint8Array, publicKeyBase64: string) {
    this.#secretKey = secretKey;
    this.publicKeyBase64 = publicKeyBase64;
  }

  /**
   * Loads this device's keypair from `app.secretStorage`, generating and persisting one on
   * first use. Reusing an existing key (rather than generating one per call) is what makes a
   * device's identity stable across restarts — see `device.test.ts`'s
   * "reuses it after" case.
   */
  static async load(app: SecretStorageHost): Promise<DeviceIdentity> {
    const stored = await app.secretStorage.getSecret(SECRET_ID);
    // `""` is what {@link forgetDeviceKey} leaves behind, because Obsidian's `SecretStorage`
    // has no delete. Treating it as a stored key would hand `getPublicKeyAsync` an empty
    // scalar; treating it as absent is what makes "disconnect, then pair again" work.
    if (stored !== null && stored !== undefined && stored !== "") {
      const secretKey = fromBase64Url(stored);
      const publicKey = await getPublicKeyAsync(secretKey);
      return new DeviceIdentity(secretKey, toBase64Url(publicKey));
    }
    const generated = await keygenAsync();
    await app.secretStorage.setSecret(SECRET_ID, toBase64Url(generated.secretKey));
    return new DeviceIdentity(generated.secretKey, toBase64Url(generated.publicKey));
  }

  /**
   * Signs raw bytes, bare. Exists to build {@link signChallenge}'s input and so a test can
   * show a bare signature differs from a bound one — **never send this result over the wire
   * directly**: the vault verifies `context_message`, not a bare challenge, and a bare
   * signature is transferable to any connection presenting the same bytes.
   */
  async sign(message: Uint8Array): Promise<string> {
    return toBase64Url(await signAsync(message, this.#secretKey));
  }

  /**
   * Signs a connection challenge for one specific vault (§8.5). This, not {@link sign}, is
   * what a `hello` frame's `signature` field carries.
   *
   * **`vaultId` must be this plugin's own stored vault id, never one read off a frame**
   * (rule 3) — the `challenge` frame carries no vault id on purpose, so a server that chose
   * what to hand back here could get a device to sign for a vault it never chose.
   */
  async signChallenge(vaultId: string, challenge: Uint8Array): Promise<string> {
    return this.sign(contextMessage(vaultId, challenge));
  }

  /**
   * Signs the routing proof the control plane needs to send this socket to the right
   * vault (O6). Base64url, no padding — it travels in a query string.
   *
   * **`vaultId` must be this device's own persisted one**, the same rule 3 that governs
   * {@link signChallenge}: a vault id taken from a response would let whoever sent it
   * choose where this device is routed.
   */
  async signRouting(deviceId: string, vaultId: string, atMs: number): Promise<string> {
    return this.sign(routingContextMessage(deviceId, vaultId, atMs));
  }

  /**
   * Signs a pairing intent's challenge (D14), so the control plane releases that intent's
   * result to this device and no other. Base64url, no padding — what `POST
   * /v1/pairing-intents/{id}/result`'s `signature` field carries (design §8).
   *
   * **`intentId` must be this device's own persisted intent id**, never one read out of a
   * response — the same rule 3 that governs {@link signChallenge}'s `vaultId`. The id is on
   * disk from the moment `startPairing` created it, so there is never a reason to take one
   * from elsewhere.
   *
   * **This is a read credential, not consent.** See {@link intentContextMessage}.
   */
  async signIntent(intentId: string, challenge: Uint8Array): Promise<string> {
    return this.sign(intentContextMessage(intentId, challenge));
  }
}
