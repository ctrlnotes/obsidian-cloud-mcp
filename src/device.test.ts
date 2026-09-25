// Rule 1's tests (spec §4.1): the private key never reaches the vault directory. See
// `device.ts`'s own doc comment for what property this actually buys, and what it does not.

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { SecretStorageHost } from "./device.ts";
import {
  CHALLENGE_BYTES,
  contextMessage,
  DeviceIdentity,
  decodeBase64Url,
  intentContextMessage,
  publicKeyStandardBase64,
  routingContextMessage,
  SECRET_ID,
} from "./device.ts";
import { fixture } from "./testing/wire-fixture.ts";

/**
 * A fake of exactly the two Obsidian surfaces this touches — `saveData` lives on the SAME
 * object `secretStorage` does, and `f.app` is the only argument `DeviceIdentity.load` ever
 * receives. A spy sitting beside `app` rather than on it cannot be reached by anything under
 * test, which is exactly the shape that let the mutation below through once already; the
 * cursor's own tripwire (`state.test.ts`'s "even offered on the same object") uses the same
 * one-object shape for the identical reason.
 */
const fakeApp = () => {
  const secrets = new Map<string, string>();
  const vaultFiles = new Map<string, string>();
  const saveData = vi.fn(async (d: unknown) => {
    vaultFiles.set(".obsidian/plugins/ctrl-notes-cloud-mcp/data.json", JSON.stringify(d));
  });
  return {
    secrets,
    vaultFiles,
    // The thing that must NEVER be used for the key.
    saveData,
    app: {
      secretStorage: {
        setSecret: (id: string, v: string) => void secrets.set(id, v),
        getSecret: (id: string) => secrets.get(id) ?? null,
        listSecrets: () => [...secrets.keys()],
      },
      saveData,
    } satisfies SecretStorageHost & { saveData(d: unknown): Promise<void> },
  };
};

test("a device generates a keypair on first use and reuses it after", async () => {
  const f = fakeApp();
  const a = await DeviceIdentity.load(f.app);
  const b = await DeviceIdentity.load(f.app);
  expect(a.publicKeyBase64).toBe(b.publicKeyBase64);
  expect(a.publicKeyBase64).toHaveLength(43); // 32 bytes, base64url, unpadded
});

test("two devices do not share a key", async () => {
  const a = await DeviceIdentity.load(fakeApp().app);
  const b = await DeviceIdentity.load(fakeApp().app);
  expect(a.publicKeyBase64).not.toBe(b.publicKeyBase64);
});

/**
 * **Rule 1, and the reason this file exists.** A key written through `saveData` lands in
 * `.obsidian/plugins/…/data.json` INSIDE the vault, which Obsidian Sync then replicates to
 * every other device — turning a device identity into a shared bearer token and making
 * "revoke this device" meaningless. It behaves identically on one device, so only a test
 * catches it.
 */
test("the private key never passes through saveData", async () => {
  const f = fakeApp();
  const d = await DeviceIdentity.load(f.app);
  await d.sign(new Uint8Array([1, 2, 3]));

  expect(f.saveData).not.toHaveBeenCalled();
  for (const contents of f.vaultFiles.values()) {
    expect(contents).not.toContain(d.publicKeyBase64);
  }
});

/**
 * **Nit fix.** `secretKey` was TypeScript `private`, which is erased at runtime — a plain
 * own enumerable property that `JSON.stringify` or a spread would happily serialise. A real
 * `#` field is not own-enumerable at all, so this is the mechanical difference the fix buys,
 * not a claim that anything currently DOES stringify the identity (nothing does — see this
 * file's own header for what property actually matters here).
 */
test("the key is not an enumerable own property of the identity object", async () => {
  const f = fakeApp();
  const d = await DeviceIdentity.load(f.app);
  const storedKeyBase64 = f.app.secretStorage.getSecret(SECRET_ID);

  expect(typeof storedKeyBase64).toBe("string");
  expect(JSON.stringify(d)).not.toContain(storedKeyBase64);
  expect(Object.keys(d)).toEqual(["publicKeyBase64"]);
});

// Belt and braces, the same style `pairing.test.ts`'s "the code is never written anywhere
// persistent" uses for a claim about a whole file rather than one call: even if a future
// fake ever put `saveData` somewhere `DeviceIdentity.load` COULD reach it, this source
// grep still catches a call from creeping back in.
test("device.ts never calls saveData", () => {
  const src = readFileSync(new URL("./device.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/\.saveData\s*\(/);
});

test("the key is stored under one known secret id", async () => {
  const f = fakeApp();
  await DeviceIdentity.load(f.app);
  expect(f.app.secretStorage.listSecrets()).toEqual([SECRET_ID]);
});

/**
 * The signature must be over `context_message`, not the bare challenge:
 * `"ctrlrouter-sync-v1" || vault_id || challenge`. A signature over the nonce alone is
 * transferable to any connection presenting the same bytes.
 */
test("a challenge is signed with its vault context, never bare", async () => {
  const f = fakeApp();
  const d = await DeviceIdentity.load(f.app);
  const challenge = new Uint8Array([9, 9, 9]);

  const bound = await d.signChallenge("vault-abc", challenge);
  const bare = await d.sign(challenge);
  expect(bound).not.toBe(bare);

  // The same challenge for a different vault is a different signature.
  expect(await d.signChallenge("vault-xyz", challenge)).not.toBe(bound);
});

test("a vault with no id still signs, domain-separated by the prefix", async () => {
  const f = fakeApp();
  const d = await DeviceIdentity.load(f.app);
  const c = new Uint8Array([1]);
  expect(await d.signChallenge("", c)).not.toBe(await d.sign(c));
});

describe("publicKeyStandardBase64", () => {
  // Rule 3's sibling bug, found on the redemption hop (`adopt.ts`): that wire decodes
  // `public_key` with base64 STANDARD (`+`/`/`, padded), never the URL-safe, unpadded
  // alphabet `publicKeyBase64` uses everywhere else. This pins the conversion
  // against bytes chosen BECAUSE they need the alphabet's differing characters, not a value
  // that happens to look the same either way.
  test("decodes to the exact bytes publicKeyBase64 names, re-encoded the other way", async () => {
    const f = fakeApp();
    const d = await DeviceIdentity.load(f.app);
    const standard = publicKeyStandardBase64(d);

    // Round-trip through the browser's own STANDARD decoder (`atob`) and compare byte for
    // byte against the same key's base64url form decoded by hand — two independent paths
    // to the same 32 bytes.
    const fromStandard = Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
    const padded = d.publicKeyBase64
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(d.publicKeyBase64.length / 4) * 4, "=");
    const fromUrl = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    expect([...fromStandard]).toEqual([...fromUrl]);
  });

  // A key picked for containing `>= 0xFB` bytes — `toString(2).length` -- forces at least
  // one `+` or `/` in its STANDARD encoding, which is exactly the byte class a URL-safe
  // string sent unconverted to a STANDARD decoder mangles.
  test("round-trips a key whose bytes need +, / and padding", () => {
    const raw = new Uint8Array(32).fill(0xfb);
    let binary = "";
    for (const b of raw) binary += String.fromCharCode(b);
    const urlForm = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fake = { publicKeyBase64: urlForm };

    const standard = publicKeyStandardBase64(fake);
    expect(standard).toContain("+");
    expect(standard.endsWith("=")).toBe(true);
    expect([...Uint8Array.from(atob(standard), (c) => c.charCodeAt(0))]).toEqual([...raw]);
  });
});

describe("the sync challenge message the vault verifies", () => {
  // The vault builds the same message independently: the prefix, then the vault id, then
  // the challenge, with no separator bytes. These tests pin this side's layout by value;
  // nothing here can verify against a real vault, which needs a live connection.
  test("signChallenge is deterministic for the same key, vault id and challenge", async () => {
    const f = fakeApp();
    const d = await DeviceIdentity.load(f.app);
    const challenge = new Uint8Array([1, 2, 3, 4]);
    const first = await d.signChallenge("vault-a", challenge);
    const second = await d.signChallenge("vault-a", challenge);
    expect(first).toBe(second);
  });

  /**
   * Determinism above is a property of ed25519, not of THIS message's
   * layout — a build that concatenated `vault_id || prefix || challenge` instead is exactly
   * as deterministic. This pins the layout itself: prefix, order, and the absence of any
   * separator, by comparing bytes directly against a message built by hand rather than
   * through `contextMessage` at all — a reversed concatenation order, or a stray separator
   * byte, fails this immediately.
   */
  test("the message signed is prefix || vault_id || challenge, byte for byte, no separators", () => {
    const prefix = new TextEncoder().encode("ctrlrouter-sync-v1");
    const vaultId = new TextEncoder().encode("vault-a");
    const challenge = new Uint8Array([1, 2, 3, 4]);
    const expected = new Uint8Array([...prefix, ...vaultId, ...challenge]);

    expect(contextMessage("vault-a", challenge)).toEqual(expected);
  });
});

/**
 * D14's half of the same idea, one flow over: a device proves it may READ a pairing
 * intent's result by signing a challenge the control plane issued for that intent.
 *
 * **The bytes must match `share::device::intent_context_message` exactly**, or every
 * pairing fails at the server with a refusal that says nothing: AT8 folds "unknown intent",
 * "expired intent" and "that signature does not verify" into one `no-such-pairing-intent`,
 * so an encoding mistake here presents as an intent that mysteriously never exists. Nothing
 * type-checks across that boundary (PL7) — `wire/pairing-intent/` is what does.
 */
describe("intentContextMessage", () => {
  const CHALLENGE = new Uint8Array(32).fill(1);

  /** The layout itself, against a message built by hand rather than through
   * `intentContextMessage` at all — a reversed order or a stray separator fails at once.
   * Determinism would not catch either (see the sync case above for why). */
  test("signs prefix || intentId || challenge, byte for byte, no separators", () => {
    const expected = new Uint8Array([
      ...new TextEncoder().encode("ctrlrouter-pairing-intent-v1"),
      ...new TextEncoder().encode("intent-7"),
      ...CHALLENGE,
    ]);

    expect(intentContextMessage("intent-7", CHALLENGE)).toEqual(expected);
  });

  /**
   * Domain separation, from this side too. `share::device`'s own
   * `an_intent_message_is_never_a_sync_message` pins it in Rust; this is the mirror. A
   * device tricked into signing one must not thereby have signed the other, so neither
   * prefix may be a prefix of the other either.
   */
  test("never signs a sync context message for an intent", () => {
    expect(intentContextMessage("i", CHALLENGE)).not.toEqual(contextMessage("i", CHALLENGE));

    // The stronger property, and the one that actually closes the length-extension reading:
    // no intent message can EQUAL a sync message for ANY inputs. `prefixA || x` equals
    // `prefixB || y` only when the shorter prefix is a prefix of the longer, so asserting on
    // the whole prefixes covers every input pair.
    //
    // **It has to be the prefixes whole.** A fixed-width window proves nothing here: both
    // deliberately begin `ctrlrouter-`, so any comparison shorter than 11 bytes matches and
    // a test built on one is asserting something untrue — which is what the first draft of
    // this test did, and `share::device`'s own version of it says so too. The prefixes are
    // module-private on both sides, so each is recovered as the message for an empty id and
    // an empty challenge.
    const empty = new Uint8Array(0);
    const intentPrefix = new TextDecoder().decode(intentContextMessage("", empty));
    const syncPrefix = new TextDecoder().decode(contextMessage("", empty));
    expect(intentPrefix.startsWith(syncPrefix)).toBe(false);
    expect(syncPrefix.startsWith(intentPrefix)).toBe(false);
  });

  /**
   * **The cross-language pin.** This fixture is checked by VALUE where every other wire
   * fixture is checked by shape: the message never appears on the wire, so the two sides
   * rebuild the signed bytes alone. The control plane asserts its own copy of the same
   * fixture; nothing connects the copies, so a disagreement shows up in production as an
   * opaque 404. Change this file only in step with the service.
   */
  test("matches the cross-language wire fixture byte for byte", () => {
    const f = fixture("pairing-intent/intent-context-message.json") as {
      intent_id: string;
      challenge_base64url: string;
      message_base64url: string;
    };

    const challenge = decodeBase64Url(f.challenge_base64url);
    const message = decodeBase64Url(f.message_base64url);
    expect(challenge).not.toBeNull();
    expect(message).not.toBeNull();
    expect(challenge).toHaveLength(CHALLENGE_BYTES);

    expect(intentContextMessage(f.intent_id, challenge as Uint8Array)).toEqual(message);
  });
});

describe("signIntent", () => {
  test("signs the intent context, never the bare challenge", async () => {
    const d = await DeviceIdentity.load(fakeApp().app);
    const challenge = new Uint8Array([4, 5, 6]);

    const bound = await d.signIntent("intent-7", challenge);
    expect(bound).not.toBe(await d.sign(challenge));
    // And not the sync proof for the same string, which is the confusion the prefix exists
    // to prevent: a sync challenge signature must not open a pairing result.
    expect(bound).not.toBe(await d.signChallenge("intent-7", challenge));
  });

  test("a different intent id is a different signature", async () => {
    const d = await DeviceIdentity.load(fakeApp().app);
    const challenge = new Uint8Array([4, 5, 6]);

    expect(await d.signIntent("intent-8", challenge)).not.toBe(
      await d.signIntent("intent-7", challenge),
    );
  });

  test("another device's signature is not this device's", async () => {
    const a = await DeviceIdentity.load(fakeApp().app);
    const b = await DeviceIdentity.load(fakeApp().app);
    const challenge = new Uint8Array([4, 5, 6]);

    expect(await a.signIntent("intent-7", challenge)).not.toBe(
      await b.signIntent("intent-7", challenge),
    );
  });
});

describe("decodeBase64Url", () => {
  // Total, because the string it is handed came off the wire: the challenge is whatever
  // the control plane sent, and a throw here would surface as an unhandled rejection
  // inside somebody else's application (`controlplane-http.ts`'s own posture).
  test("decodes what toBase64Url produced, including both url-safe characters", async () => {
    const d = await DeviceIdentity.load(fakeApp().app);
    const signature = await d.sign(new Uint8Array([1, 2, 3]));
    expect(decodeBase64Url(signature)).toHaveLength(64);
  });

  test.each([
    ["standard-alphabet input", "a+b/c"],
    ["a stray space", "ab cd"],
    ["not base64 at all", "!!!!"],
  ])("reads %s as no bytes at all, rather than throwing", (_name, raw) => {
    expect(decodeBase64Url(raw)).toBeNull();
  });
});

describe("the sync routing message", () => {
  /**
   * Pinned by VALUE against a fixture the control plane asserts its own copy of,
   * because nothing type-checks across that boundary and the message never
   * appears on the wire — the query string carries a device id, a key, a
   * timestamp and a signature, and each side rebuilds the signed bytes alone.
   *
   * A disagreement here would present as a socket that will not open, with the
   * control plane answering every routing refusal identically and nothing in
   * either log to say why.
   */
  test("matches the cross-language wire fixture byte for byte", () => {
    const f = fixture("sync-routing/routing-context-message.json") as {
      device_id: string;
      vault_id: string;
      at_ms: number;
      message_base64url: string;
    };
    const expected = decodeBase64Url(f.message_base64url);
    expect(expected).not.toBeNull();
    expect(routingContextMessage(f.device_id, f.vault_id, f.at_ms)).toEqual(expected);
  });

  /**
   * The reason both variable parts carry a length. Without them these two
   * would sign identical bytes, and one signature would authorise routing to a
   * vault the device never named.
   */
  test("moving the boundary between the two ids changes the bytes", () => {
    expect(routingContextMessage("ab", "c", 1)).not.toEqual(routingContextMessage("a", "bc", 1));
  });
});
