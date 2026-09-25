// The plugin's half of `GET /v1/sync/signal`'s wire contract (vault-sleep VS8, PL7).
//
// The control plane answers `{"seq": n}` or `{"seq": null}`, and asserts its real response
// body equals its own copy of each fixture below. This file asserts `readSignal` reads
// these bytes as the number and as "unknown". The service keeps its own copy of these fixtures, and nothing connects the two: a
// change to the response is made in both repositories by hand.

import { describe, expect, test } from "vitest";
import { fixture } from "../testing/wire-fixture.ts";
import { readSignal } from "./park.ts";

describe("GET /v1/sync/signal: readSignal parses the control plane's fixtures", () => {
  test("a number", () => {
    expect(readSignal(fixture("controlplane/v1-sync-signal.response.json"))).toBe(42);
  });

  test("null is unknown, not malformed", () => {
    expect(readSignal(fixture("controlplane/v1-sync-signal.response.null.json"))).toBeNull();
  });
});
