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
  MIN_WIRE_VERSION,
  readDownFrame,
  UnknownDownFrameError,
  WIRE_VERSION,
  WireVersionMismatchError,
} from "./wire.ts";

describe("every documented down fixture decodes", () => {
  // Drives the wire contract from this side too: if a fixture and this decoder disagree,
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
    "down.closing_never.json",
    "down.applied_batch.json",
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

/**
 * Bulk-ingest design BI1: 4 is this build's version, and 3 is still spoken so that a vault not
 * yet moved to a v4 release can be reached (`MIN_WIRE_VERSION`'s doc comment).
 */
describe("the wire versions this build speaks", () => {
  const challenge = (wire_version: number) => ({
    type: "challenge",
    wire_version,
    challenge: "Y2hhbA",
  });

  it("is 3 to 4", () => {
    expect([MIN_WIRE_VERSION, WIRE_VERSION]).toEqual([3, 4]);
  });

  it.each([3, 4])("accepts a challenge of %i", (v) => {
    expect(decodeDown(challenge(v))).toMatchObject({ type: "challenge", wire_version: v });
  });

  it.each([2, 5])("refuses a challenge of %i", (v) => {
    expect(() => decodeDown(challenge(v))).toThrow(WireVersionMismatchError);
  });
});

/**
 * BI1's `retry`, decoded leniently: only an explicit `never` stops this device. Anything else —
 * absent (a v3 vault), a value from some future vault, the wrong type — is `later`, and none of
 * them may throw, because a decode error on a frame after the handshake is terminal.
 *
 * **Proven able to fail** by decoding with `str(v.retry, …)`: the absent, 7 and null rows throw.
 */
describe("a closing's retry field", () => {
  const retry = (extra: Record<string, unknown>) => {
    const d = decodeDown({ type: "closing", reason: "r", ...extra });
    return d.type === "closing" ? d.retry : null;
  };

  it("never decodes as never", () => {
    expect(retry({ retry: "never" })).toBe("never");
  });

  it.each([
    ["later", { retry: "later" }],
    ["absent", {}],
    ["an unknown value", { retry: "park" }],
    ["a number", { retry: 7 }],
    ["null", { retry: null }],
  ])("%s decodes as later, without throwing", (_label, extra) => {
    expect(retry(extra)).toBe("later");
  });
});

/**
 * Bulk-ingest design BI5. A vault older than `put_batch` sends a `ready` with no limits, and
 * that must read as "no batching", not as a malformed frame — a decode error on `ready` would
 * fail the handshake with every vault not yet moved to a batching release.
 */
describe("the batch limits a ready frame carries", () => {
  it("read as 0 and 0 when the vault sends none", () => {
    expect(decodeDown({ type: "ready", seq: 7 })).toEqual({
      type: "ready",
      seq: 7,
      max_batch_ops: 0,
      max_batch_bytes: 0,
    });
  });

  it("are read when present", () => {
    expect(
      decodeDown({ type: "ready", seq: 7, max_batch_ops: 100, max_batch_bytes: 4194304 }),
    ).toMatchObject({ max_batch_ops: 100, max_batch_bytes: 4194304 });
  });

  it("are still an error when present and not numbers", () => {
    expect(() => decodeDown({ type: "ready", seq: 7, max_batch_ops: "100" })).toThrow();
  });
});

describe("an applied_batch answer", () => {
  it("needs both lists", () => {
    expect(() => decodeDown({ type: "applied_batch", applied: [] })).toThrow(/refused/);
    expect(() => decodeDown({ type: "applied_batch", refused: [] })).toThrow(/applied/);
  });

  it("carries a null seq and a null current_sha through", () => {
    expect(
      decodeDown({
        type: "applied_batch",
        applied: [{ path: "a.md", seq: null, sha: "s" }],
        refused: [{ path: "b.md", reason: "r", current_sha: null }],
      }),
    ).toEqual({
      type: "applied_batch",
      applied: [{ path: "a.md", seq: null, sha: "s" }],
      refused: [{ path: "b.md", reason: "r", current_sha: null }],
    });
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
    ) as { sha: string; bytes: number };
    expect(encoded.sha).toBe("1a2b3c4d5e6f");
    expect(encoded.bytes).toBe(1_048_576);
    expect(Number.isInteger(encoded.bytes)).toBe(true);
  });

  it("a base_sha of null (a brand-new path) survives, rather than being dropped", () => {
    const encoded = JSON.parse(
      encodeUp({ type: "put", path: "new.md", base_sha: null, sha: "abc", bytes: 3 }),
    ) as Record<string, unknown>;
    expect(encoded.base_sha).toBeNull();
    expect("base_sha" in encoded).toBe(true);
  });
});
