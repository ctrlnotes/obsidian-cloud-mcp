// The plugin's half of the sync wire contract, against `test-fixtures/wire/vault-sync/`.
//
// It encodes a representative `Up` value and checks it against each `up.*.json` fixture's
// shape, and decodes each `down.*.json` fixture with this plugin's own decoder and checks
// that succeeds. The vault tests its side against its own copy of the same fixtures.
//
// Adding or renaming a field on either side is a breaking change to a deployed interface.
// This test fails until the matching fixture here is updated. The service's copy is not in
// this repository and nothing connects the two, so a protocol change is made in both by
// hand, deliberately.

import { describe, expect, test } from "vitest";
import { assertShape, fixture, type JsonValue } from "./testing/wire-fixture.ts";
import { decodeDown, encodeUp, type Up } from "./wire.ts";

function encodedShape(up: Up): JsonValue {
  return JSON.parse(encodeUp(up)) as JsonValue;
}

describe("up frames: the plugin's encoder matches the fixture's shape", () => {
  test("hello", () => {
    assertShape(
      fixture("vault-sync/up.hello.json"),
      encodedShape({
        type: "hello",
        wire_version: 4,
        device_id: "dev-a1b2c3",
        signature: "c2ln",
        since_seq: 41,
      }),
    );
  });

  test("ack", () => {
    assertShape(fixture("vault-sync/up.ack.json"), encodedShape({ type: "ack", seq: 4821 }));
  });

  test("put", () => {
    assertShape(
      fixture("vault-sync/up.put.json"),
      encodedShape({
        type: "put",
        path: "projects/alpha.md",
        base_sha: "9f2c1a4e",
        sha: "1a2b3c4d",
        bytes: 1024,
      }),
    );
  });

  test("delete", () => {
    assertShape(
      fixture("vault-sync/up.delete.json"),
      encodedShape({ type: "delete", path: "projects/alpha.md", base_sha: "9f2c1a4e" }),
    );
  });

  test("rename", () => {
    assertShape(
      fixture("vault-sync/up.rename.json"),
      encodedShape({ type: "rename", from: "a.md", to: "b.md" }),
    );
  });

  test("snapshot", () => {
    assertShape(fixture("vault-sync/up.snapshot.json"), encodedShape({ type: "snapshot" }));
  });

  // Two entries, one with a base and one without: the fixture's array shape is taken from its
  // first element, so it must be the one carrying a string `base_sha`, and the `null` in the
  // second is what a brand-new path sends.
  test("put_batch", () => {
    assertShape(
      fixture("vault-sync/up.put_batch.json"),
      encodedShape({
        type: "put_batch",
        puts: [
          { path: "projects/alpha.md", base_sha: "9f2c1a4e", sha: "1a2b3c4d", bytes: 1024 },
          { path: "projects/beta.md", base_sha: null, sha: "2b3c4d5e", bytes: 0 },
        ],
      }),
    );
  });
});

// Minor/nit fix, folded into one: the checks below used to be one-directional — they
// proved `decodeDown` does not throw and named the right `.type`, but nothing checked the
// SHAPE it produced against the fixture. `decodeDown` builds a fresh object literal from
// only the fields it knows, so a field ADDED to a fixture (the vault growing `Down::Event`
// a new field, say) was silently dropped here while the Rust side alone would have
// demanded the fixture change first. `assertShape` runs both directions: a fixture field
// the plugin never reads is "missing field", and a plugin field the fixture never declared
// (unreachable today, since `decodeDown` only ever emits modelled keys) is "not in the
// wire fixture" — the same two-sided check `up frames` above already gets from
// `encodedShape`.
describe("down frames: the plugin's decoder accepts the fixture verbatim, in shape too", () => {
  test("challenge", () => {
    const f = fixture("vault-sync/down.challenge.json");
    const d = decodeDown(f);
    expect(d.type).toBe("challenge");
    expect(d.type === "challenge" && d.wire_version).toBe(4);
    assertShape(f, d as unknown as JsonValue);
  });

  // The batch limits by value too: they decide whether this device batches at all, and a
  // decoder that read both as 0 would pass the shape check while never sending a batch.
  test("ready", () => {
    const f = fixture("vault-sync/down.ready.json");
    const d = decodeDown(f);
    expect(d.type).toBe("ready");
    expect(d.type === "ready" && [d.max_batch_ops, d.max_batch_bytes]).toEqual([100, 4194304]);
    assertShape(f, d as unknown as JsonValue);
  });

  test("applied_batch", () => {
    const f = fixture("vault-sync/down.applied_batch.json");
    const d = decodeDown(f);
    expect(d.type).toBe("applied_batch");
    if (d.type === "applied_batch") {
      expect(d.applied.length).toBeGreaterThan(0);
      expect(d.refused.length).toBeGreaterThan(0);
    }
    assertShape(f, d as unknown as JsonValue);
  });

  test("event", () => {
    const f = fixture("vault-sync/down.event.json");
    const d = decodeDown(f);
    expect(d.type).toBe("event");
    assertShape(f, d as unknown as JsonValue);
  });

  // A second fixture for the same variant: `rename` is the only kind that
  // populates `from`, and it is the field the plugin cannot apply the event
  // without. Testing only the `null` case would leave the shape that matters
  // unchecked on both sides of the contract.
  test("event (rename, carrying `from`)", () => {
    const f = fixture("vault-sync/down.event_rename.json");
    const d = decodeDown(f);
    expect(d.type).toBe("event");
    expect(d.type === "event" && d.from).toBe("projects/alpha.md");
    assertShape(f, d as unknown as JsonValue);
  });

  // The page that carries the new meaning: "do not apply this yet". A fixture
  // showing only `more: false` would leave the shape that changes behaviour
  // untested on both sides.
  test("snapshot (a page, with more to come)", () => {
    const f = fixture("vault-sync/down.snapshot_page.json");
    const d = decodeDown(f);
    expect(d.type).toBe("snapshot");
    expect(d.type === "snapshot" && d.more).toBe(true);
    assertShape(f, d as unknown as JsonValue);
  });

  test("applied", () => {
    const f = fixture("vault-sync/down.applied.json");
    const d = decodeDown(f);
    expect(d.type).toBe("applied");
    assertShape(f, d as unknown as JsonValue);
  });

  test("refused", () => {
    const f = fixture("vault-sync/down.refused.json");
    const d = decodeDown(f);
    expect(d.type).toBe("refused");
    assertShape(f, d as unknown as JsonValue);
  });

  test("snapshot", () => {
    const f = fixture("vault-sync/down.snapshot.json");
    const d = decodeDown(f);
    expect(d.type).toBe("snapshot");
    if (d.type === "snapshot") {
      expect(d.files.length).toBeGreaterThan(0);
    }
    assertShape(f, d as unknown as JsonValue);
  });

  // `retry` is asserted by VALUE as well as by shape (bulk-ingest design BI1): it is the one
  // field on this wire whose value decides whether this device keeps syncing, and a shape
  // check alone would pass a decoder that read every closing as `later`.
  test("closing (retry later)", () => {
    const f = fixture("vault-sync/down.closing.json");
    const d = decodeDown(f);
    expect(d.type).toBe("closing");
    expect(d.type === "closing" && d.retry).toBe("later");
    assertShape(f, d as unknown as JsonValue);
  });

  // A second fixture for the same variant, like `event_rename` and `snapshot_page`: `never`
  // is the value that stops sync, so it is the one that must not go untested on either side.
  test("closing (retry never)", () => {
    const f = fixture("vault-sync/down.closing_never.json");
    const d = decodeDown(f);
    expect(d.type).toBe("closing");
    expect(d.type === "closing" && d.retry).toBe("never");
    assertShape(f, d as unknown as JsonValue);
  });
});

test("the checked-in fixtures load", () => {
  // If path resolution broke, every contract test above would silently start throwing on
  // load rather than checking anything.
  expect(fixture("vault-sync/up.ack.json")).toHaveProperty("type", "ack");
});
