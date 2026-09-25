// Tests for the two forward-compatibility rules `wire.ts` exists to carry — see that
// file's header. The wire CONTRACT itself (does every documented frame decode/encode to
// the fixtures' shape) is `wire.contract.test.ts`; this file is about how the plugin
// reacts to a frame the contract does not cover at all — one from a build ahead of it, or
// behind it.

import { describe, expect, it, vi } from "vitest";
import { fixture } from "./testing/wire-fixture.ts";
import {
  decodeDown,
  encodeUp,
  readDownFrame,
  UnknownDownFrameError,
  WIRE_VERSION,
  WireVersionMismatchError,
} from "./wire.ts";

describe("every documented down fixture decodes", () => {
  // Drives Task 2's contract from this side too: if a fixture and this decoder disagree,
  // this fails alongside `wire.contract.test.ts`.
  it.each([
    "down.challenge.json",
    "down.ready.json",
    "down.event.json",
    "down.event_rename.json",
    "down.applied.json",
    "down.refused.json",
    "down.snapshot.json",
    "down.snapshot_page.json",
    "down.closing.json",
  ])("%s", (name) => {
    expect(() => decodeDown(fixture(`vault-sync/${name}`))).not.toThrow();
  });
});

describe("an unknown down frame is skipped, not fatal", () => {
  const future = { type: "reindexed", path: "n.md", at_ms: 1 };

  it("readDownFrame returns null rather than throwing", () => {
    expect(() => readDownFrame(future)).not.toThrow();
    expect(readDownFrame(future, () => {})).toBeNull();
  });

  it("logs what happened, naming the unrecognised type", () => {
    const warn = vi.fn();
    readDownFrame(future, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reindexed");
  });

  it("decodeDown itself still throws — readDownFrame is the tolerant wrapper, not a change to what decodeDown means", () => {
    expect(() => decodeDown(future)).toThrow(UnknownDownFrameError);
  });

  it("a KNOWN type with a malformed field is still fatal through readDownFrame too", () => {
    // Tolerance is scoped to an unrecognised `type` alone. A `ready` frame this build
    // claims to understand but cannot actually parse is a real bug, not a version skew,
    // and must not be swallowed the same way.
    expect(() => readDownFrame({ type: "ready", seq: "not a number" })).toThrow();
  });
});

describe("a wire_version mismatch refuses and names the version", () => {
  const future = { type: "challenge", wire_version: 99, challenge: "Y2hhbA" };

  it("decodeDown throws, naming the version the vault asked for", () => {
    expect(() => decodeDown(future)).toThrow(WireVersionMismatchError);
    try {
      decodeDown(future);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WireVersionMismatchError);
      expect((e as WireVersionMismatchError).serverWireVersion).toBe(99);
      expect((e as Error).message).toContain("99");
    }
  });

  it("readDownFrame refuses too — this is the opposite case from an unknown frame type", () => {
    expect(() => readDownFrame(future)).toThrow(WireVersionMismatchError);
  });

  it("the fixture's own version is one this build actually speaks", () => {
    // If this ever fails, `WIRE_VERSION` and the checked-in fixture have drifted apart —
    // fix the fixture (with the vault side, per `wire/vault-sync/README.md`), not this test.
    const challenge = fixture("vault-sync/down.challenge.json") as { wire_version: number };
    expect(challenge.wire_version).toBe(WIRE_VERSION);
  });
});

describe("a put's byte count and sha are carried exactly", () => {
  it("round-trips through JSON with no coercion or loss", () => {
    const encoded = JSON.parse(
      encodeUp({
        type: "put",
        path: "projects/alpha.md",
        base_sha: "9f2c1a4e",
        sha: "1a2b3c4d5e6f",
        bytes: 1_048_576,
      }),
    );
    expect(encoded.sha).toBe("1a2b3c4d5e6f");
    expect(encoded.bytes).toBe(1_048_576);
    expect(Number.isInteger(encoded.bytes)).toBe(true);
  });

  it("a base_sha of null (a brand-new path) survives, rather than being dropped", () => {
    const encoded = JSON.parse(
      encodeUp({ type: "put", path: "new.md", base_sha: null, sha: "abc", bytes: 3 }),
    );
    expect(encoded.base_sha).toBeNull();
    expect("base_sha" in encoded).toBe(true);
  });
});
